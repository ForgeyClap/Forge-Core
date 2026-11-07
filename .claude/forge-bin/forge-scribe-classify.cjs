#!/usr/bin/env node
'use strict';
/**
 * forge-scribe-classify.cjs — the deterministic NL+EN keyword classifier for Forge Scribe (* audit SCRIBE-F10). No LLM call, no network, pure functions.
 *
 * Rule: every class in config.classifier.patterns sums the weights of its matching patterns. The class
 * with the highest score wins. A zero score, or a tie for the top score, gives 'unclassified' — the
 * classifier NEVER guesses; the Lead settles an unclassified item with one CLI call
 * (`forge-scribe.cjs classify R-n <class>`).
 *
 * API:
 *   loadConfig(file?)               -> parsed FORGE_SCRIBE.json (compiled regexes cached on the object)
 *   classify(text, cfg)             -> { class, scores, multi_ask, asks }
 *   splitSentences(text)            -> [{ text, start, end }]  (char spans into the original text)
 *   authorizes(text, rid, intent, cfg) -> { ok, how:'rid'|'list'|'range'|'batch', sentence } | { ok:false, reason }   (Codex R3 SC-01, R5 SV-01)
 *   idRanges(sentence, cfg)         -> [{lo, hi, text, gap, bad}]  the id ranges of one sentence (WP-ACK-RANGE)
 *   clausesOf(sentence, cfg, intent?) -> [{ text, sep }]  · isQuestion(sentence, cfg) -> bool   (R5 SV-01)
 *   machineSkip(text)               -> null for owner text, else why it is machine text  (Codex R3 SC-11)
 *   findRepeats(text, items, cfg)   -> null | {repeat_of, repeat_count, score, tokens}  (owner repeats, see OWNER REPEATS)
 *   CLASSES                         -> the classes a caller may set by hand (+ 'unclassified')
 *
 * AUTHORIZES (Codex R3 SC-01, bound to ONE item since Codex R5 SV-01): an owner prompt
 * authorises ack/cancel of R-n only through an AFFIRMATIVE act bound to R-n itself (or a configured batch phrase):
 *   - every sentence that names R-n (or the batch phrase) is judged; one that fails makes the prompt ambiguous, and
 *     ambiguous never authorises. A sentence fails when it is a QUESTION (ends with '?', or opens with an interrogative
 *     or a yes/no verb: "R-0001 approved?", "Is R-0001 approved"), carries a CONDITION anywhere ("if", "unless", "once",
 *     "als", "mits", "zodra" …), or holds a clause WITHOUT any R-id that negates or defers ("…, not yet", "…, wacht nog");
 *   - the sentence is cut into CLAUSES at , : ; dashes/parentheses and at contrast words ("but", "except", "maar",
 *     "behalve" …). The clause naming R-n must itself classify, with this same classifier, as the intent ('ack' or
 *     'cancel'); once the intent's own pattern matches and the R-ids are removed, no negation word and no conflict word
 *     ("pending", "remains", "later", "wacht", "nog niet", "blijft" …) may remain. A clause that is ONLY R-ids
 *     ("Approve R-0002, R-0001") belongs to the nearest act clause reached through list separators only — never across
 *     a contrast word ("Approve R-0002 but R-0001" never approves R-0001);
 *   - a batch phrase authorises only in a sentence with no contrast word / dash / parenthesis (no exceptions), and every
 *     clause naming R-n elsewhere must still agree.
 *   - SHARED LIST (WP-ACK-LIST, ack only): a sentence made ONLY of 2+ R-ids, list glue (, en and &), shared
 *     affirmative predicates (owner_check.shared_ack_predicates: klopt, kloppen, akkoord, ok, done, "is gedaan" …) and
 *     closing punctuation authorises each id it names ("R-0006, R-0007 en R-0012 kloppen."). Any other word leaves
 *     residue and the one-item binding applies; there, an act shared by several ids (a bare list item or a clause naming
 *     several ids) is refused when the sentence holds a contrast cut or a negation anywhere.
 *   - ID RANGES (WP-ACK-RANGE, owner prompt P-000122 "R-0103 t/m R-0121 klopt"): an INCLUSIVE range names every
 *     id inside it, endpoints included, for ack and cancel. A range is two R-ids with ONLY a connector between them: t/m,
 *     tm, tot en met, through, to, a hyphen or an en dash (any case, leading zeros optional). The range is read as ONE
 *     list sharing one act ("R-0103 & R-0110 & R-0121 klopt" for R-0110), so every rule above for a shared act applies: a
 *     question, a condition, any exception or negation anywhere in the sentence refuses every id of the range. A dash
 *     DIRECTLY between two ids is a range connector; a dash anywhere else still cuts clauses as a contrast, as before.
 *     A malformed range (backwards, from an id to itself, chained, or wider than owner_check.range_max, default 60) refuses
 *     every id named in its sentence. Guards carry the mutation anchors RANGE-GUARD-* and RANGE-ONE-CLAUSE.
 * "Approve R-0002, but R-0001 remains pending." approves R-0002 and never R-0001. A mere mention ("R-0001 staat nog
 * open") is not an act. The word lists live in FORGE_SCRIBE.json owner_check (defaults below).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SCRIBE.json');
const CLASSES = ['new', 'change', 'cancel', 'preference', 'question', 'ack', 'unclassified'];
const DEFAULT_NEGATIONS = ['not', 'never', 'no', 'niet', 'geen', 'nooit', 'nee'];
// Forge's own tool subcommands: `/forge status` is the owner operating a tool, not a wish (moved here from the hook).
const FORGE_TOOL_SUBCOMMANDS = ['status', 'runs', 'dashboard', 'open-report', 'doctor', 'config', 'snapshot', 'help', 'version', 'plan', 'start', 'use', 'resume'];

function loadConfig(file) {
  const p = file || DEFAULT_CONFIG;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!cfg || !cfg.classifier || !cfg.classifier.patterns || !cfg.caps) {
    throw new Error('forge-scribe: config ' + p + ' is missing classifier.patterns or caps');
  }
  return cfg;
}

function compiled(cfg) {
  if (cfg.__compiled) return cfg.__compiled;
  const out = {};
  for (const cls of Object.keys(cfg.classifier.patterns)) {
    out[cls] = cfg.classifier.patterns[cls].map((p) => ({ re: new RegExp(p.re, 'i'), w: Number(p.w) || 1 }));
  }
  Object.defineProperty(cfg, '__compiled', { value: out, enumerable: false });
  return out;
}

function scoreText(text, cfg) {
  const pats = compiled(cfg);
  const scores = {};
  for (const cls of Object.keys(pats)) {
    let s = 0;
    for (const p of pats[cls]) if (p.re.test(text)) s += p.w;
    scores[cls] = s;
  }
  return scores;
}

function pickClass(scores) {
  let best = null, bestScore = 0, tie = false;
  for (const cls of Object.keys(scores)) {
    const s = scores[cls];
    if (s > bestScore) { best = cls; bestScore = s; tie = false; }
    else if (s === bestScore && s > 0) tie = true;
  }
  if (!best || bestScore === 0 || tie) return 'unclassified';
  return best;
}

/** Sentence spans: split on . ! ? ; and newlines, keeping the terminator with its sentence. */
function splitSentences(text) {
  const s = String(text || '');
  const out = [];
  const re = /[^.!?;\n]+[.!?;]*/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + lead;
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

function classify(text, cfg) {
  const t = String(text == null ? '' : text);
  const scores = scoreText(t, cfg);
  const cls = pickClass(scores);
  // multi-ask: count sentences that classify on their own as an actionable ask.
  const sentences = splitSentences(t);
  let asks = 0;
  if (sentences.length > 1) {
    for (const sen of sentences) {
      const c = pickClass(scoreText(sen.text, cfg));
      if (c === 'new' || c === 'change' || c === 'cancel' || c === 'preference') asks++;
    }
  }
  const threshold = Number(cfg.caps.multi_ask_threshold) || 3;
  return { class: cls, scores, asks, multi_ask: asks >= threshold };
}

// ---------------------------------------------------------------- owner acts (SC-01)

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function negationRe(cfg) {
  const words = (cfg && cfg.owner_check && Array.isArray(cfg.owner_check.negation_words) ? cfg.owner_check.negation_words : DEFAULT_NEGATIONS)
    .map((w) => String(w).trim()).filter(Boolean);
  // "n't" (don't, isn't, won't …) is a negation in every English contraction
  return new RegExp('(?:\\b(?:' + words.map(escRe).join('|') + ')\\b|n[\'’]t\\b)', 'i');
}
/** stripIntent(sentence, intent, cfg) — the sentence with every span the intent class's own patterns match removed, so
 *  a cancel phrase that itself contains a negation ("hoeft niet meer", "don't need") is the act, not a negation of it. */
function stripIntent(sentence, intent, cfg) {
  let s = String(sentence);
  for (const p of compiled(cfg)[intent] || []) s = s.replace(new RegExp(p.re.source, 'gi'), ' ');
  return s;
}
// SV-01 word lists (defaults; FORGE_SCRIBE.json owner_check overrides each list). Regex sources, case-insensitive.
const DEFAULT_CONTRAST = ['but', 'however', 'except', 'excluding', 'although', 'though', 'whereas', 'while', 'yet', 'apart from', 'other than', 'only',
  'maar', 'behalve', 'echter', 'hoewel', 'terwijl', 'doch', 'alleen', 'uitgezonderd', 'behoudens'];
const DEFAULT_CONDITIONALS = ['if', 'unless', 'once', 'provided', 'providing', 'assuming', 'when', 'whenever', 'as soon as', 'after', 'before', 'until',
  'als', 'indien', 'mits', 'tenzij', 'zodra', 'wanneer', 'nadat', 'voordat', 'totdat', 'mocht', 'zo gauw', 'op voorwaarde'];
const DEFAULT_CONFLICTS = ['pending', 'remains?', 'still', 'later', 'wait(?:ing)?', 'on hold', 'hold (?:it|off|on)', 'blocked', 'reject(?:ed)?', 'declined?',
  'den(?:y|ied)', 'reopen\\w*', '(?:keep|leave) [^.!?\\n]{0,30}open', 'nog (?:niet|even|open|wachten|bekijken)', 'staat (?:nog )?open', 'blijf\\w*',
  'wacht\\w*', 'openstaand\\w*', 'afgekeurd', 'afwijz\\w*', 'weiger\\w*', 'aanhoud\\w*', 'heropen\\w*', 'straks', 'eerst nog',
  'tomorrow', 'morgen', 'next (?:week|time|sprint|month|release)', 'volgende (?:week|keer|sprint|maand|release)', 'eventually', 'someday', 'ooit', 'binnenkort'];
const DEFAULT_QUESTION_STARTS = ['is', 'are', 'was', 'were', 'has', 'have', 'had', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will', 'shall',
  'may', 'might', 'must', 'how', 'why', 'what', 'which', 'when', 'where', 'who', 'kan', 'kun', 'kunt', 'zou', 'zal', 'zijn', 'heeft', 'hebben', 'mag',
  'moet', 'wil', 'wilt', 'hoe', 'waarom', 'wat', 'welke', 'wanneer', 'waar', 'wie'];
const listOf = (cfg, key, dflt) => {
  const v = cfg && cfg.owner_check && Array.isArray(cfg.owner_check[key]) ? cfg.owner_check[key] : dflt;
  return v.map((w) => String(w).trim()).filter(Boolean);
};
/** wordsRe(sources) — one case-insensitive regex that matches any of the sources (regex sources) as whole words. */
function wordsRe(sources) {
  return new RegExp('(?:^|[^\\p{L}\\p{N}])(?:' + sources.map((w) => w.replace(/ /g, '\\s+')).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'iu');
}
function ownerCheckRes(cfg) {
  if (cfg && cfg.__ownerRes) return cfg.__ownerRes;
  const contrastWords = listOf(cfg, 'contrast_words', DEFAULT_CONTRAST).map(escRe);
  const res = {
    neg: negationRe(cfg),
    conditional: wordsRe(listOf(cfg, 'conditional_words', DEFAULT_CONDITIONALS).map(escRe)),
    conflict: wordsRe(listOf(cfg, 'conflict_words', DEFAULT_CONFLICTS)),
    questionStart: new RegExp('^\\s*(?:' + listOf(cfg, 'question_starts', DEFAULT_QUESTION_STARTS).map(escRe).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'iu'),
    // a contrast word (or a dash / parenthesis) separates clauses and breaks a list; , and : are list separators
    contrastSep: '(?:\\s*[\\u2013\\u2014()\\[\\]]\\s*|\\s+-\\s+|(?:^|[\\s,:]+)(?:' + contrastWords.map((w) => w.replace(/ /g, '\\s+')).join('|') + ')(?=$|[^\\p{L}\\p{N}])\\s*)',
  };
  if (cfg && typeof cfg === 'object') Object.defineProperty(cfg, '__ownerRes', { value: res, enumerable: false });
  return res;
}
/** clausesOf(sentence, cfg, intent?) -> [{text, sep:'start'|'list'|'contrast'}] — SV-01: list separators , : and contrast
 *  separators (contrast words, dashes, parentheses). `sep` is how the clause is joined to the one before it. A separator
 *  inside a span the intent's own patterns match is part of the act phrase, never a cut ("Laat R-0009 maar zitten"). */
function clausesOf(sentence, cfg, intent) {
  const s = String(sentence);
  const R = ownerCheckRes(cfg);
  const masks = [];
  for (const p of (intent ? compiled(cfg)[intent] || [] : [])) {
    const re = new RegExp(p.re.source, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) { if (m[0].length) masks.push([m.index, m.index + m[0].length]); else re.lastIndex++; }
  }
  const masked = (a, b) => masks.some(([x, y]) => a < y && b > x);
  const seps = [];
  for (const [src, type] of [['\\s*[,:]\\s*', 'list'], [R.contrastSep, 'contrast']]) {
    const re = new RegExp(src, 'giu');
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      if (!masked(m.index, m.index + m[0].length)) seps.push({ a: m.index, b: m.index + m[0].length, type });
    }
  }
  seps.sort((x, y) => x.a - y.a || y.b - x.b);
  const merged = [];
  for (const x of seps) {
    const last = merged[merged.length - 1];
    if (last && x.a < last.b) { last.b = Math.max(last.b, x.b); if (x.type === 'contrast') last.type = 'contrast'; }
    else merged.push(Object.assign({}, x));
  }
  const out = [];
  let from = 0, sep = 'start';
  for (const x of merged.concat([{ a: s.length, b: s.length, type: 'end' }])) {
    const text = s.slice(from, x.a).trim();
    if (text) { out.push({ text, sep }); sep = x.type; }
    else if (x.type === 'contrast' || sep === 'start') sep = sep === 'start' && x.type !== 'contrast' ? 'start' : 'contrast';
    from = x.b;
  }
  return out;
}
/** isBareList(clause) — only R-ids and list glue (and/en/&/plus/or/of), nothing else. */
const isBareList = (s) => !String(s).replace(/\bR-\d+\b/gi, ' ').replace(/(?:^|[^\p{L}\p{N}])(?:and|en|&|plus|or|of)(?=$|[^\p{L}\p{N}])/giu, ' ').replace(/[\s\p{P}\p{S}]/gu, '');
/** isQuestion(sentence, cfg) — ends with '?', opens with an interrogative / yes-no verb, or the question patterns fire. */
function isQuestion(sentence, cfg) {
  const s = String(sentence).trim();
  if (/\?\s*$/.test(s)) return true;
  if (ownerCheckRes(cfg).questionStart.test(s)) return true;
  return Number(scoreText(s, cfg).question) > 0;
}
/** clauseVerdict(clause, intent, cfg) -> null when the clause is an affirmative act of the intent, else why not. */
function clauseVerdict(clause, intent, cfg) {
  const R = ownerCheckRes(cfg);
  const cls = pickClass(scoreText(clause, cfg));
  const rest = stripIntent(clause, intent, cfg).replace(/\bR-\d+\b/gi, ' ');
  if (cls !== intent) return 'classifier reads it as ' + cls;
  if (R.neg.test(rest)) return 'negated';
  if (R.conflict.test(rest)) return 'it defers or disputes the act (' + (rest.match(R.conflict) || [''])[0].trim() + ')';
  return null;
}
// WP-ACK-LIST: ONE affirmative predicate shared by a list of ids ("R-0006, R-0007 en R-0012 kloppen.").
const DEFAULT_SHARED_ACK = ['klopt', 'kloppen', 'akkoord', 'goed', 'goedgekeurd', 'bevestigd', 'approved', 'confirmed', 'ok', 'okay', 'yes', 'done',
  'is gedaan', 'zijn gedaan'];
const LIST_GLUE_RE = /(?:^|[^\p{L}\p{N}])(?:en|and|&)(?=$|[^\p{L}\p{N}])/giu;
/** sharedListAck(sentence, cfg) -> the listed ids when the sentence is ONLY R-ids, list glue (, en and &), shared
 *  affirmative predicates (owner_check.shared_ack_predicates) and closing punctuation, with at least two ids and one
 *  predicate; else null. A whitelist: any other word (a negation, contrast, condition, deferral, "tot en met") leaves
 *  residue and the sentence falls back to the one-item binding below. It never expands a range itself: authorizes()
 *  hands it a sentence whose ranges are already rewritten as lists (rangesAsList). */
function sharedListAck(sentence, cfg) {
  const s = String(sentence);
  if (/\?/.test(s)) return null;
  const ids = s.match(/\bR-\d+\b/gi) || [];
  if (ids.length < 2) return null;
  const preds = listOf(cfg, 'shared_ack_predicates', DEFAULT_SHARED_ACK).sort((a, b) => b.length - a.length);
  const predRe = new RegExp('(?:^|[^\\p{L}\\p{N}])(?:' + preds.map((w) => escRe(w).replace(/ /g, '\\s+')).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
  const noIds = s.replace(/\bR-\d+\b/gi, ' ');
  if (!predRe.test(noIds)) return null;
  const residue = noIds.replace(predRe, ' ').replace(LIST_GLUE_RE, ' ').replace(/[\s,.!:;]/g, '');
  if (residue) return null;
  const R = ownerCheckRes(cfg); // belt and braces: the whitelist already excludes these
  if (R.neg.test(noIds) || R.conditional.test(noIds) || R.conflict.test(noIds) || new RegExp(R.contrastSep, 'iu').test(noIds)) return null;
  return ids.map((x) => x.toUpperCase());
}
// WP-ACK-RANGE: an inclusive id range ("R-0103 t/m R-0121 klopt", owner prompt P-000122). See the header (ID RANGES).
// A connector counts only when it is the ONLY thing between two R-ids. A hyphen / en dash there is a range connector, not
// a contrast cut; a dash anywhere else still cuts clauses as before. "tot" alone, an em dash, "en", "of" are no connectors.
const RANGE_CONNECTOR_RE = /^\s*(?:t\s*\/\s*m|tm|tot\s+en\s+met|through|to|-|\u2013)\s*$/i;
const DEFAULT_RANGE_MAX = 60;
const RANGE_JOIN = ' & '; // RANGE-ONE-CLAUSE: list glue that is no clause cut, so the whole range stays ONE shared act
/** rangeMax(cfg) — owner_check.range_max (a whole number >= 0; 0 or 1 refuses every range), else 60. */
function rangeMax(cfg) {
  const v = cfg && cfg.owner_check ? cfg.owner_check.range_max : undefined;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_RANGE_MAX;
}
/** idRanges(sentence, cfg) -> [{lo, hi, text, gap:[a,b], bad}] — every "R-a <connector> R-b" in the sentence. `gap` is the
 *  connector's span; `bad` (null when valid) says why the range is malformed: it runs backwards or from an id to itself,
 *  it spans more than range_max ids, or it is chained to another range ("R-1 t/m R-3 t/m R-5"). Pure. */
function idRanges(sentence, cfg) {
  const s = String(sentence);
  const ids = [];
  const re = /\bR-(\d+)\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) ids.push({ n: parseInt(m[1], 10), a: m.index, b: m.index + m[0].length });
  const max = rangeMax(cfg);
  const out = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const x = ids[i], y = ids[i + 1];
    if (!RANGE_CONNECTOR_RE.test(s.slice(x.b, y.a))) continue;
    const r = { lo: Math.min(x.n, y.n), hi: Math.max(x.n, y.n), text: s.slice(x.a, y.b), gap: [x.b, y.a], at: i, bad: null };
    if (x.n >= y.n) r.bad = 'runs backwards or from an id to itself'; // RANGE-GUARD-ORDER
    if (!r.bad && r.hi - r.lo + 1 > max) r.bad = 'spans ' + (r.hi - r.lo + 1) + ' ids, more than owner_check.range_max (' + max + ')'; // RANGE-GUARD-CAP
    out.push(r);
  }
  for (let k = 1; k < out.length; k++) if (out[k].at === out[k - 1].at + 1) out[k].bad = out[k - 1].bad = 'is chained to another range'; // RANGE-GUARD-CHAIN
  return out;
}
/** rangesAsList(sentence, ranges, n) — the sentence with every range connector replaced by list glue, and R-n put inside
 *  each range that holds it, so "R-0103 t/m R-0121 klopt" reads, for R-0110, as "R-0103 & R-0110 & R-0121 klopt": one
 *  clause, one act shared by several ids — the shared-list rules of authorizes() then apply unchanged. */
function rangesAsList(sentence, ranges, n) {
  let s = String(sentence);
  for (const r of ranges.slice().sort((p, q) => q.gap[0] - p.gap[0])) {
    const inner = r.lo < n && n < r.hi ? RANGE_JOIN + 'R-' + String(n).padStart(4, '0') + RANGE_JOIN : RANGE_JOIN;
    s = s.slice(0, r.gap[0]) + inner + s.slice(r.gap[1]);
  }
  return s;
}
/** authorizes(text, rid, intent, cfg) — see the header (AUTHORIZES). intent: 'ack' | 'cancel'. Pure. */
function authorizes(text, rid, intent, cfg) {
  const n = /^R-(\d+)$/i.test(String(rid)) ? parseInt(String(rid).slice(2), 10) : NaN;
  if (!Number.isFinite(n)) return { ok: false, reason: 'not an item id: ' + rid };
  if (intent !== 'ack' && intent !== 'cancel') return { ok: false, reason: 'unknown owner intent ' + intent };
  const oc = (cfg && cfg.owner_check) || {};
  const phrases = (intent === 'ack' ? oc.batch_ack_phrases : oc.batch_cancel_phrases) || [];
  const ridRe = new RegExp('\\bR-0*' + n + '\\b', 'i');
  const R = ownerCheckRes(cfg);
  const no = (sen, why) => ({ ok: false, reason: 'the sentence ' + JSON.stringify(String(sen).slice(0, 120)) + ' ' + why + ' — ambiguous never authorises' });
  let affirm = null;
  for (const sen of splitSentences(text)) {
    const low = sen.text.toLowerCase();
    const ranges = idRanges(sen.text, cfg);
    const inRange = ranges.find((r) => r.lo <= n && n <= r.hi);
    const literal = ridRe.test(sen.text);
    const named = literal || !!inRange;
    const batchPhrase = phrases.find((ph) => ph && low.includes(String(ph).toLowerCase()));
    if (!named && !batchPhrase) continue;
    const names = 'names ' + rid + (literal || !inRange ? '' : ' through the range ' + JSON.stringify(inRange.text));
    const what = named ? names : 'holds the batch phrase ' + JSON.stringify(batchPhrase);
    if (isQuestion(sen.text, cfg)) return no(sen.text, what + ' but is a question');
    if (R.conditional.test(sen.text)) return no(sen.text, what + ' but is conditional (' + (sen.text.match(R.conditional) || [''])[0].trim() + ')');
    const badRange = ranges.find((r) => r.bad);
    if (badRange) return no(sen.text, what + ' but holds the range ' + JSON.stringify(badRange.text) + ', which ' + badRange.bad); // RANGE-GUARD-BAD
    // from here on a range reads as a list of ids sharing ONE act (R-n put inside the range that holds it)
    const body = ranges.length ? rangesAsList(sen.text, ranges, n) : sen.text;
    if (named && intent === 'ack' && sharedListAck(body, cfg)) { // a list of ids sharing ONE affirmative predicate
      if (!affirm) affirm = { ok: true, how: literal ? 'list' : 'range', sentence: sen.text.slice(0, 200) };
      continue;
    }
    const clauses = clausesOf(body, cfg, intent);
    // a clause without ANY R-id that negates or defers poisons the sentence ("Approve R-0001, not yet")
    for (const cl of clauses) {
      if (/\bR-\d+\b/i.test(cl.text) || (batchPhrase && cl.text.toLowerCase().includes(String(batchPhrase).toLowerCase()))) continue;
      const rest = stripIntent(cl.text, intent, cfg);
      if (R.neg.test(rest) || R.conflict.test(rest)) return no(sen.text, what + ' but the clause ' + JSON.stringify(cl.text.slice(0, 60)) + ' negates or defers it');
    }
    if (named) {
      for (let i = 0; i < clauses.length; i++) {
        if (!ridRe.test(clauses[i].text)) continue;
        let anchor = i;
        if (isBareList(clauses[i].text)) { // a bare list item belongs to the nearest act clause reached through list separators only
          anchor = -1;
          for (let j = i; j > 0 && clauses[j].sep === 'list'; j--) if (!isBareList(clauses[j - 1].text)) { anchor = j - 1; break; }
          if (anchor < 0) for (let j = i + 1; j < clauses.length && clauses[j].sep === 'list'; j++) if (!isBareList(clauses[j].text)) { anchor = j; break; }
          if (anchor < 0) return no(sen.text, names + ' without an act bound to it (a bare mention, or across a contrast word)');
        }
        // an act shared with other ids (a bare list item, or a clause naming several ids) never survives an exception
        // or a negation anywhere in the sentence ("R-0002 en R-0003 akkoord, maar R-0004 niet" approves none of them)
        const shared = anchor !== i || (clauses[anchor].text.match(/\bR-\d+\b/gi) || []).length > 1;
        if (shared && (clauses.some((x) => x.sep === 'contrast') || R.neg.test(stripIntent(body, intent, cfg).replace(/\bR-\d+\b/gi, ' ')))) {
          return no(sen.text, names + ' in a list that shares one act with other ids, and the sentence carries an exception or a negation — a shared act never has exceptions');
        }
        const why = clauseVerdict(clauses[anchor].text, intent, cfg);
        if (why) return no(sen.text, names + ' in the clause ' + JSON.stringify(clauses[anchor].text.slice(0, 80)) + ', which is not an affirmative ' + intent + ' (' + why + ')');
      }
    } else {
      if (clauses.some((x) => x.sep === 'contrast')) return no(sen.text, what + ' but carries an exception (a contrast word, dash or parenthesis) — a batch act never has exceptions');
      const cl = clauses.find((x) => x.text.toLowerCase().includes(String(batchPhrase).toLowerCase())) || { text: body };
      const why = clauseVerdict(cl.text, intent, cfg);
      if (why) return no(sen.text, what + ' but is not an affirmative ' + intent + ' (' + why + ')');
    }
    if (!affirm) affirm = { ok: true, how: named ? (literal ? 'rid' : 'range') : 'batch', sentence: sen.text.slice(0, 200) };
  }
  return affirm || { ok: false, reason: 'no sentence names ' + rid + ' or a batch ' + intent + ' phrase' };
}

// ---------------------------------------------------------------- leading harness blocks (.8)

/** stripLeadingHarness(text) -> {text, stripped} —.8: Claude Code / the IDE / Claude in Chrome put
 *  their own blocks IN FRONT of the owner's words in the same prompt (<browser_instruction>, <ide_opened_file>,
 *  <ide_selection>, <system-reminder>). Every such CLOSED block at the start (CRLF, multi-line, nested and repeated
 *  blocks included) is removed so only the owner's words remain; `stripped` = how many blocks went. An unclosed leading
 *  block changes NOTHING (the whole text comes back as is, stripped 0: the old behaviour). Pure, never throws. */
const HARNESS_LEAD_TAGS = ['browser_instruction', 'ide_opened_file', 'ide_selection', 'system-reminder'];
const HARNESS_LEAD_MAX_BLOCKS = 64;
function harnessBlockEnd(s, tag) {
  const re = new RegExp('<(/?)' + tag + '(?=[\\s>/])[^>]*>', 'gi');
  let depth = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) { depth--; if (depth === 0) return re.lastIndex; } else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  return -1;
}
function stripLeadingHarness(text) {
  const raw = String(text == null ? '' : text);
  try {
    let s = raw.replace(/^﻿/, '');
    let n = 0;
    while (n < HARNESS_LEAD_MAX_BLOCKS) {
      s = s.replace(/^\s+/, '');
      const m = /^<([a-z][a-z0-9_-]*)(?=[\s>])/i.exec(s);
      if (!m || !HARNESS_LEAD_TAGS.includes(m[1].toLowerCase())) break;
      const end = harnessBlockEnd(s, m[1].toLowerCase());
      if (end < 0) return { text: raw, stripped: 0 }; // unclosed: keep the old behaviour
      s = s.slice(end);
      n++;
    }
    return n ? { text: s.replace(/^\s+/, ''), stripped: n } : { text: raw, stripped: 0 };
  } catch { return { text: raw, stripped: 0 }; }
}

// ---------------------------------------------------------------- machine text (SC-11)

/** machineSkip(text) -> null for owner text, else why it is NOT the owner talking. Pure. Only machine-generated
 *  messages are skipped (Codex R3 SC-11): a background agent's <task-notification> turn, tool-result / local-command
 *  echoes, the BODY of a slash command or skill (YAML frontmatter, "Base directory for this skill"), a slash-command
 *  expansion that STARTS the text and carries no arguments or runs a Forge tool subcommand, a bare slash command, and
 *  Forge's own tool subcommands. An inline <command-name> inside owner prose, a question and an ack are the owner. */
function machineSkip(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '').trimStart();
  if (/^<task-notification>/i.test(s)) return 'task-notification';
  if (/^<(?:tool[_-]result|function_results|local-command-(?:stdout|stderr|caveat)|bash-(?:input|stdout|stderr)|system-reminder|user-prompt-submit-hook)\b/i.test(s)) return 'tool-result';
  if (/^\[\s*\{\s*"(?:type|tool_use_id)"\s*:\s*"(?:tool_result|toolu_)/.test(s)) return 'tool-result';
  if (/^Caveat: The messages below were generated by the user while running local commands/i.test(s)) return 'tool-result';
  if (/^<command-(?:name|message|args)>/i.test(s)) {
    const name = (/<command-name>\s*\/?([^<\s]*)\s*<\/command-name>/i.exec(s) || [])[1] || '';
    const args = ((/<command-args>([\s\S]*?)<\/command-args>/i.exec(s) || [])[1] || '').trim();
    if (!args) return 'slash-command-expansion';
    if (/^forge(?:-core)?(?::[\w-]+)?$/i.test(name) && FORGE_TOOL_SUBCOMMANDS.includes(String(args.split(/\s+/)[0]).toLowerCase())) return 'forge-tool-command';
    return null; // the arguments are the owner's own words
  }
  if (/^Base directory for this skill:/i.test(s)) return 'slash-command-expansion';
  if (/^---\r?\n(?:[^\n]*\r?\n){0,12}?(?:description|name|argument-hint|allowed-tools|model)\s*:/.test(s)) return 'slash-command-expansion';
  if (/^\/[\w:.-]+\s*$/.test(s)) return 'bare-slash-command';
  const m = /^\/forge(?:-core)?(?::[\w-]+)?\s+([\w-]+)/i.exec(s);
  if (m && FORGE_TOOL_SUBCOMMANDS.includes(m[1].toLowerCase())) return 'forge-tool-command';
  return null;
}

// ---------------------------------------------------------------- owner repeats (WP-SCRIBE-REPEAT)
/* OWNER REPEATS (global ~/.claude/CLAUDE.md 'Owner repeats = HARD RULE'): the owner had to ask six times for parallel
 * lanes. The second time the owner says the same thing it is a hard rule at once, so the scribe flags a NEW prompt that
 * repeats an earlier owner ask. CHEAP by design (it runs inside the UserPromptSubmit hook's time budget): token sets
 * only, no LLM, no network, each text capped at repeat.max_chars, at most repeat.max_candidates earlier items.
 * TOKENS: lower-case letter runs (digits and punctuation dropped), >= 3 letters, minus the NL+EN stopwords and cue words,
 * light stemming (plural -en for words > 5 letters, -s for words > 4), then the concept groups map synonyms to one token
 * ('lanes', 'agents', 'parallel', 'parralel' -> #parallel; 'opruimen', 'ruim', 'cleanup' -> #cleanup ...). A concept
 * token carries its group weight (default 1, #parallel 2), a plain token weighs 1.
 * MATCH (new prompt N vs earlier item E, shared = weighted N∩E, +cue_bonus when N holds a cue word such as 'steeds',
 * 'weer', 'nogmaals', 'again', 'ik moet' and shares at least one token):
 *   (a) weighted Jaccard >= repeat.jaccard (0.45) with shared >= 2, or
 *   (b) shared >= repeat.min_shared (3) — at least three shared distinctive tokens (a concept counts its weight), or
 *   (c) containment shared / weight(N) >= repeat.containment (0.5) with shared >= 2 and weight(N) >= 2 — a short
 *       prompt ("meer lanes?") that says nothing but what was already asked.
 * One shared plain word never matches on its own. ELIGIBLE earlier items: an owner prompt (pid), not cancelled or
 * superseded, not an ack, not an answered pure question.
 * QUIET RULES (WP-REPEAT-FP, 2026-10-11 — the first-day false positive "open vragen nog voor mij of wat ik moet doen?"
 * flagged REPEAT x4 through the ordinary word 'vragen' plus the cue 'ik moet'):
 *   1. a match needs at least ONE shared DISTINCTIVE token: a concept token (#parallel, #watchdog, #cleanup, #extra) or
 *      a plain content word of >= repeat.distinctive_min_len letters. Generic words (vragen, moet, doen, nog, wat, open,
 *      ask, need, status ...) are stopwords (repeat.stopwords + the built-in GENERIC list) and never score.
 *   2. a pure STATUS QUESTION (question form + a status word such as 'nog'/'open'/'gedaan', no complaint cue, no
 *      imperative start) is never flagged against a non-question earlier item unless it shares a weight-2 concept token
 *      AND holds a complaint cue (so in practice: never; it can still repeat an earlier question).
 *   3. cue words alone never create a repeat: the cue bonus only counts once a distinctive token is shared.
 * COUNT: repeat_count = 1 + the size of the chain the matched items belong to (connected through repeat_of), i.e. how
 * many times the owner has now asked; for a plain chain that is 1 + the earlier item's repeat_count (an original = 1). */
const GENERIC_REPEAT_WORDS = ['vragen', 'vraag', 'vroeg', 'moet', 'moeten', 'doen', 'nog', 'wat', 'voor', 'mij', 'open',
  'ask', 'asked', 'asking', 'need', 'needs', 'question', 'questions', 'status'];
const REPEAT_DEFAULTS = {
  enabled: true, jaccard: 0.45, min_shared: 3, containment: 0.5, cue_bonus: 1, max_chars: 2000, max_candidates: 400, min_len: 3,
  distinctive_min_len: 4,
  status_words: ['nog', 'open', 'openstaand', 'openstaande', 'gedaan', 'gebeuren', 'doen', 'status', 'todo', 'left', 'remaining', 'pending'],
  imperative_starts: ['zet', 'maak', 'start', 'voeg', 'ruim', 'doe', 'bouw', 'fix', 'verander', 'make', 'add', 'build', 'run', 'set'],
  complaint_words: ['steeds', 'weer', 'nogmaals', 'opnieuw', 'alweer', 'again', 'herhalen', 'herhaal'],
  cue_words: ['steeds', 'weer', 'nogmaals', 'opnieuw', 'alweer', 'again', 'herhalen', 'herhaal', 'repeat', 'repeating'],
  cue_phrases: ['once more', 'ik moet', 'i keep', 'i have to keep', 'for the third time', 'voor de derde keer', 'zoals ik al zei', 'as i said'],
  stopwords: [],
  concepts: [
    { token: 'parallel', weight: 2, words: ['lane', 'lanes', 'agent', 'agents', 'subagent', 'subagents', 'parallel', 'parallelle', 'parallele', 'parralel', 'parrallel', 'paralel', 'parallell', 'parralell', 'concurrent', 'concurrently', 'tegelijk', 'tegelijkertijd'] },
    { token: 'watchdog', weight: 2, words: ['watchdog', 'watchdogs', 'waakhond', 'waakhonden'] },
    { token: 'cleanup', weight: 2, words: ['opruimen', 'ruim', 'ruimen', 'ruimt', 'opgeruimd', 'cleanup', 'clean', 'opschonen', 'schoonmaken'] },
    { token: 'extra', weight: 1, words: ['extra', 'additional', 'additionele'] },
  ],
};

function repeatConfig(cfg) {
  if (cfg && cfg.__repeat) return cfg.__repeat;
  const user = (cfg && cfg.repeat && typeof cfg.repeat === 'object') ? cfg.repeat : {};
  const R = Object.assign({}, REPEAT_DEFAULTS, user);
  const low = (a) => (Array.isArray(a) ? a : []).map((w) => String(w).toLowerCase());
  // the word lists live in FORGE_SCRIBE.json repeat.*; a config without them falls back to the impact stopwords
  R.stop = new Set(low(Array.isArray(user.stopwords) ? user.stopwords : (cfg && cfg.impact && cfg.impact.stopwords)));
  for (const w of GENERIC_REPEAT_WORDS) R.stop.add(w);   // QUIET RULE 1: generic words never score, whatever the config
  R.cues = new Set(low(R.cue_words));
  R.complaints = new Set(low(R.complaint_words));
  R.statusWords = new Set(low(R.status_words));
  R.imperatives = new Set(low(R.imperative_starts));
  R.minDistinct = Number(R.distinctive_min_len) > 0 ? Number(R.distinctive_min_len) : 4;
  R.phrases = low(R.cue_phrases);
  R.concept = new Map();
  for (const g of (Array.isArray(R.concepts) ? R.concepts : [])) {
    if (!g || !g.token) continue;
    const tok = '#' + String(g.token).toLowerCase();
    for (const w of low(g.words)) R.concept.set(w, { tok, w: Number(g.weight) > 0 ? Number(g.weight) : 1 });
  }
  if (cfg && typeof cfg === 'object') Object.defineProperty(cfg, '__repeat', { value: R, enumerable: false, configurable: true });
  return R;
}

function stemWord(w) {
  if (w.length > 5 && w.endsWith('en')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** repeatTokens(text, cfg) -> Map token -> weight (see OWNER REPEATS). Pure. */
function repeatTokens(text, cfg) {
  const R = repeatConfig(cfg);
  const out = new Map();
  const words = String(text == null ? '' : text).slice(0, R.max_chars).toLowerCase().match(/\p{L}+/gu) || [];
  for (const w of words) {
    if (w.length < R.min_len || R.stop.has(w) || R.cues.has(w)) continue;
    const st = stemWord(w);
    if (R.stop.has(st)) continue;
    const c = R.concept.get(w) || R.concept.get(st);
    if (c) out.set(c.tok, c.w); else out.set(st, 1);
  }
  return out;
}

/** repeatCue(text, cfg) -> true when the prompt holds a repeat cue word or phrase. Pure. */
function repeatCue(text, cfg) {
  const R = repeatConfig(cfg);
  const s = String(text == null ? '' : text).slice(0, R.max_chars).toLowerCase();
  if ((s.match(/\p{L}+/gu) || []).some((w) => R.cues.has(w))) return true;
  return R.phrases.some((p) => new RegExp('(?:^|[^\\p{L}])' + escRe(p) + '(?![\\p{L}])', 'u').test(s));
}

const weightOf = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };

/** repeatDistinctive(token, cfg) -> true for a concept token or a plain content word >= distinctive_min_len (QUIET RULE 1). */
function repeatDistinctive(tok, cfg) {
  const R = repeatConfig(cfg);
  return tok.charAt(0) === '#' || (tok.length >= R.minDistinct && !R.stop.has(tok));
}

/** repeatScore(newTok, oldTok, cue, cfg) -> {match, shared, jaccard, containment, tokens, distinctive, w2}. Pure. */
function repeatScore(nt, ot, cue, cfg) {
  const R = repeatConfig(cfg);
  let shared = 0, distinctive = 0, w2 = 0;
  const tokens = [];
  for (const [k, v] of nt) {
    if (!ot.has(k)) continue;
    const w = Math.max(v, ot.get(k));
    shared += w; tokens.push(k);
    if (repeatDistinctive(k, cfg)) distinctive++;
    if (k.charAt(0) === '#' && w >= 2) w2++;
  }
  const nw = weightOf(nt), ow = weightOf(ot);
  // QUIET RULE 3: the cue bonus (and so a cue word) only counts once a distinctive token is shared
  const bonus = cue && distinctive > 0 ? (Number(R.cue_bonus) || 0) : 0;
  const s = shared + bonus;
  const union = nw + ow - shared;
  const jaccard = union > 0 ? s / union : 0;
  const containment = nw > 0 ? Math.min(1, s / nw) : 0;
  const match = distinctive > 0 && ((jaccard >= R.jaccard && s >= 2) || s >= R.min_shared || (containment >= R.containment && s >= 2 && nw >= 2));
  return { match, shared: s, jaccard, containment, tokens, distinctive, w2 };
}

/** repeatStatusQuestion(text, cfg) -> true for a pure question about status/open items (QUIET RULE 2): question form
 *  (question mark or an interrogative start), a status word, no complaint cue, no imperative start. Pure. */
function repeatStatusQuestion(text, cfg) {
  const R = repeatConfig(cfg);
  const s = String(text == null ? '' : text).slice(0, R.max_chars).trim();
  const words = s.toLowerCase().match(/\p{L}+/gu) || [];
  if (!words.length || !words.some((w) => R.statusWords.has(w))) return false;
  if (words.some((w) => R.complaints.has(w)) || R.imperatives.has(words[0])) return false;
  if (/\?/.test(s)) return true;
  try { return isQuestion(s, cfg); } catch { return false; }
}

const repeatComplaint = (text, cfg) => {
  const R = repeatConfig(cfg);
  return (String(text == null ? '' : text).slice(0, R.max_chars).toLowerCase().match(/\p{L}+/gu) || []).some((w) => R.complaints.has(w));
};
// the scribe's own class decides: "kan je niet parallel werken?" is captured as a request (change), not a question
const earlierIsQuestion = (it) => it.class === 'question';

/** repeatEligible(item) — an earlier OWNER ask a new prompt can repeat (see OWNER REPEATS). */
function repeatEligible(it) {
  if (!it || !it.pid || !it.rid) return false;
  if (it.status === 'cancelled' || it.status === 'superseded') return false;
  if (it.class === 'ack') return false;
  if (it.class === 'question' && it.status === 'answered') return false;
  return true;
}

const ridNum = (r) => parseInt(String(r).replace(/^R-/i, ''), 10) || 0;

/** findRepeats(text, items, cfg) -> null | {repeat_of:[rid], repeat_count, score, tokens}. items: the scribe's item
 *  objects (state.items values). Pure, bounded (max_candidates newest eligible items, max_chars per text). */
function findRepeats(text, items, cfg) {
  const R = repeatConfig(cfg);
  if (R.enabled === false) return null;
  const nt = repeatTokens(text, cfg);
  if (!nt.size) return null;
  const cue = repeatCue(text, cfg);
  const statusQ = repeatStatusQuestion(text, cfg);
  const complaint = statusQ ? repeatComplaint(text, cfg) : false;
  const elig =(Array.isArray(items) ? items : Object.values(items || {})).filter(repeatEligible).sort((a, b) => ridNum(a.rid) - ridNum(b.rid));
  const cands = elig.slice(-Math.max(1, Number(R.max_candidates) || 400));
  const hits = [];
  let best = 0;
  const toks = new Set();
  for (const it of cands) {
    const sc = repeatScore(nt, repeatTokens(it.quote || it.title || '', cfg), cue, cfg);
    if (!sc.match) continue;
    // QUIET RULE 2: a pure status question vs a non-question earlier ask needs a weight-2 concept AND a complaint cue
    if (statusQ && !earlierIsQuestion(it) && !(sc.w2 > 0 && complaint)) continue;
    hits.push(it.rid);
    best = Math.max(best, sc.shared);
    sc.tokens.forEach((x) => toks.add(x));
  }
  if (!hits.length) return null;
  // the chain: every eligible item connected to a hit through repeat_of (both directions)
  const byRid = new Map(elig.map((i) => [i.rid, i]));
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const i of elig) for (const r of (Array.isArray(i.repeat_of) ? i.repeat_of : [])) if (byRid.has(r)) { link(i.rid, r); link(r, i.rid); }
  const seen = new Set(hits);
  const queue = hits.slice();
  while (queue.length) { const r = queue.pop(); for (const n of (adj.get(r) || [])) if (!seen.has(n)) { seen.add(n); queue.push(n); } }
  return { repeat_of: hits, repeat_count: seen.size + 1, score: best, tokens: Array.from(toks) };
}

// ---------------------------------------------------------------- toggle corrections (WP I.8c)
/* TOGGLE CORRECTIONS (docs/claude-md/intelligence-bar.md rule 4: count the owner's "turn it on / you forgot" corrections
 * per mission). toggleCorrection(text, cfg) marks an OWNER message with the TAG 'toggle-correction' (never a class: the
 * six classes are pinned) when it says Forge should have enabled, used or done something unasked, or that the owner had
 * to say it before. The caller passes the owner's OWN words (forge-scribe.cjs runs the origin filter and ownerWords
 * first); quoted spans, inline/fenced code and '>' lines are dropped here too (someone else's words). NL + EN keyword
 * rules on tokens, conservative (a missed correction costs less than a polluted metric):
 *   STRONG (alone):  burden      the owner's repeat complaint: a repetition word (steeds, telkens, elke keer, alweer, weer,
 *                                opnieuw, hoe vaak, again, keep ...; altijd/always/still/nog steeds only with moet/have to)
 *                                within TOGGLE window words of a say/ask/turn-on verb (vragen, zeggen, herhalen, aanzetten,
 *                                ask, tell, remind ...), said by ik/we (or "en moet ..."), or "je vraagt steeds";
 *                    stop-asking "vraag (ook) niet steeds", "je hoeft niet te vragen", "stop asking me", "don't keep asking";
 *                    meta        "denkt niet (met mij) mee", "dit moet je zelf doen", "zonder dat ik het hoef te vragen",
 *                                "without being asked", "you should do this yourself".
 *                    Never when a product actor speaks or is asked ("de bot vraagt steeds", "de klant", "the customer").
 *   WEAK (need a Forge SWITCH word in the same sentence, or anywhere in a message of <= short_message_chars):
 *                    toggle-on ("zet ... aan/open", "turn on", "enable"), use ("gebruik ... ook", "je moet ... gebruiken",
 *                    "also use"), forgot ("vergeet niet", "je bent ... vergeten", "you forgot"; never the cancel "vergeet
 *                    die X" or "ik ben vergeten"), why-not ("waarom ... niet", "why didn't you"), should-have ("je had ...
 *                    moeten", "you should have"), omission ("je hebt ... niet gebruikt", "you didn't run"), again-omission
 *                    (alweer/weer/again/still WITH niet/geen/vergeten/stopped ...), never-again ("dit moet niet meer
 *                    gebeuren"), cant-you ("kan je niet ...?", not an explain request), did-you-also ("heb je ook ...
 *                    gebruikt?"), already-said ("heb ik al gezegd", "I already told you").
 *                    "zet ... uit" / "turn off" / "disable" is never a cue on its own (only an omission cue beside it).
 *   SWITCH words: Forge capabilities (lanes, parallel, subagents, watchdog, codex, worktrees, deep research, code review,
 *   usage guard, hard rule, a /command ...). AMBIGUOUS ones (agent, review, test, lint, hook, skill, release, rotator ...)
 *   do not count when the context names a product thing (app, pagina, knop, formulier, checkout, CI, image ...): "Enable
 *   reviews on the product page" and "zet de lamp aan in de app" are tasks, not corrections.
 * -> {tagged, tag, cue, strong, switch_word, sentence}. Pure, bounded (max_chars). Config (optional, FORGE_SCRIBE.json
 * toggle_correction): enabled, short_message_chars, max_chars, window. Limits: keyword heuristics — no sarcasm or irony,
 * Dutch compounds only through the listed stems, a correction phrased without any listed cue is missed. */
const TOGGLE_TAG = 'toggle-correction';
const TOGGLE_MARK = '[tc]';
const TOGGLE_DEFAULTS = { enabled: true, short_message_chars: 240, max_chars: 4000, window: 8 };
const TC_JOIN = [
  [/\bnog steeds\b/g, 'nog_steeds'], [/\b(?:elke|iedere) (?:keer|dag)\b/g, 'elke_keer'], [/\bkeer op keer\b/g, 'elke_keer'],
  [/\bhoe vaak\b/g, 'hoe_vaak'], [/\bhow (?:many times|often)\b/g, 'hoe_vaak'], [/\b(?:voor )?de (?:zoveelste|tweede|derde|vierde|vijfde|\d+e) keer\b/g, 'nth_keer'],
  [/\b(?:for )?the (?:umpteenth|second|third|fourth|fifth|nth|\d+(?:st|nd|rd|th)) time\b/g, 'nth_keer'], [/\b(?:every|each) (?:time|day)\b/g, 'elke_keer'],
  [/\ball the time\b/g, 'elke_keer'], [/\bover and over(?: again)?\b/g, 'elke_keer'], [/\bdeep[ -]research\b/g, 'deep_research'],
  [/\b(?:status|progress|voortgangs?)[ -]?updates?\b/g, 'status_update'], [/\busage[ -]guard\b/g, 'usage_guard'], [/\b(?:hard|standing)[ -]rules?\b/g, 'hard_rule'],
  [/\bscreenshot[ -]loop\b/g, 'screenshot_loop'], [/\bcode[ -]reviews?\b/g, 'code_review'], [/\b(?:dark|light)[ -]mode\b/g, 'dark_mode'], [/\bdonkere modus\b/g, 'dark_mode'],
  [/\bgithub actions\b/g, 'github_actions'], [/\bvoice[ -]?(?:agent|bot)s?\b/g, 'voice_agent'], [/\bsub[ -]agents?\b/g, 'subagent'],
];
const tcSet = (s) => new Set(s.split(' '));
const TC_REP_STRONG = tcSet('steeds steds telkens elke_keer alweer weer opnieuw nogmaals hoe_vaak nth_keer again repeatedly keep kept');
const TC_REP_WEAK = tcSet('altijd constant continu nog_steeds always still constantly');
const TC_KEEP_NEXT = tcSet('asking telling saying reminding repeating having needing forgetting');
const TC_ASK = tcSet('vragen vraag vraagt vroeg vroegen omvragen omvraag zeggen zeg zegt zei herhalen herhaal herhaalt vertellen vertel aangeven melden typen roepen '
  + 'herinneren aanzetten openzetten inschakelen activeren ask asking asked tell telling told say saying remind reminding repeat repeating enable enabling');
const TC_FIRST = tcSet("ik mij me we wij i i'm i've we've");
const TC_DETERMINERS = tcSet("de het een die deze mijn jouw je zijn haar onze elke welke zo'n the this that a your");
const TC_MODAL_RE = /\b(?:moet|moest|moeten|must|have to|has to|had to|need to|needs to|keep|kept)\b/;
const TC_ACTOR_RE = /\b(?:de|het|die|deze|onze|mijn|een|the|a|an|our|my|this|that|your|jouw)\s+(?:\S+\s+)?(?:bot|chatbot|voicebot|assistent|assistant|klant|klanten|gebruiker|gebruikers|beller|bellers|caller|callers|customer|customers|user|users|bezoeker|bezoekers|visitor|visitors|app|website|formulier|form|medewerker|medewerkers|receptionist|agent|ai)\b|\b(?:voice_agent|klanten|gebruikers|bellers|bezoekers|medewerkers|leden|patienten|patiënten|clienten|cliënten|customers|users|callers|visitors|members|patients|clients)\b/;
const TC_PRODUCT_RE = /(?:pagina|knop|scherm|formulier|winkel|bestelling|klant|product|component)|\b(?:apps?|applicatie|page|pages|website|site|webshop|homepage|landing|button|buttons|screen|form|forms|lamp|lampen|licht|lichten|light|lights|dark_mode|menu|header|footer|sidebar|navbar|modal|popup|pop-up|customer|customers|checkout|winkelwagen|cart|order|orders|ui|widget|ci|pipeline|github_actions|workflow|workflows|n8n|cv|profiel|profile|dashboard|image|images|foto|fotos|slider|carousel|banner|voice_agent|chatbot|bot)\b/;
const TC_SWITCH = tcSet('lane lanes parallel parallelle parallele parallell parralel parrallel paralel parralell parallelism subagent subagents watchdog watchdogs '
  + 'waakhond waakhonden codex worktree worktrees deep_research forge usage_guard hard_rule screenshot_loop ultracode code_review');
const TC_SWITCH_AMBIGUOUS = tcSet('agent agents review reviews reviewer test tests testen typecheck typechecks lint linter e2e playwright check checks hook hooks skill skills '
  + 'plugin plugins mcp release releases releasen screenshot screenshots tegelijk tegelijkertijd concurrent concurrently memory geheugen rotator scribe triage verifier goat status_update');
const TC_SLASH_RE = /(?:^|\s)(\/[a-z][\w:.-]{1,40})/;
const TC_EXPLAIN_RE = /\b(?:uitleggen|uitleg|vertellen|vertel|laten\s+zien|beschrijven|samenvatten|explain|describe|tell\s+me|show\s+me|summari[sz]e|walk\s+me)\b/;
const TC_OMIT_RE = /\b(?:niet|geen|nooit|vergeten|vergeet|gestopt|stopt|stoppen|stopte|vast|zonder|kwijt|ontbreekt|mist|not|no|never|without|forgot|forgotten|stopped|stops|missing)\b|n't\b/;
const TC_OFF = [/\bzet\b(?:\s+\S+){0,6}?\s+uit\b/, /\buit\s*(?:te\s+)?zetten\b/, /\buitgezet\b/, /\buitschakel\w*/, /\bturn(?:s|ed|ing)?\b(?:\s+\S+){0,4}?\s+off\b/, /\bdisabl(?:e|es|ed|ing)\b/, /\bswitch(?:es|ed|ing)?\b(?:\s+\S+){0,4}?\s+off\b/];
const TC_PART = '(?:gebruikt|aangezet|gedraaid|gestart|ingezet|ingeschakeld|opgestart|gecheckt|gecontroleerd|getest|gedaan|uitgevoerd|meegenomen|bekeken|geactiveerd|aangeroepen)';
const TC_EN_VERB = '(?:use|used|using|run|ran|running|start|started|enable|enabled|turn|launch|launched|spin|spun|check|checked|test|tested|verify|verified|spawn|spawned|try|tried)';
const TC_STOP_ASK = [/\bniet\s+(?:steeds|telkens|elke_keer|meer)\s+(?:om\s+)?(?:toestemming|bevestiging|goedkeuring|akkoord|permissie)\s+(?:te\s+)?vragen\b/,
  /\b(?:je|jij)\s+hoeft\s+(?:(?:het|dat|dit|me|mij|er|ook)\s+){0,2}niet\s+(?:(?:steeds|telkens|meer|elke_keer)\s+)?(?:te\s+)?vragen\b/, /\bstop\s+(?:nou\s+|eens\s+)?met\s+(?:\S+\s+){0,2}?vragen\b/,
  /\b(?:stop|quit)\s+asking\b/, /\bdo(?:n'?t| not)\s+keep\s+asking\b/, /\byou\s+do(?:n'?t| not)\s+(?:need|have)\s+to\s+(?:keep\s+)?ask(?:ing)?\b/, /\bno\s+need\s+to\s+(?:keep\s+)?ask(?:ing)?\b/];
const TC_META_FREE = [/\bdenk\w*\s+(?:\S+\s+){0,3}?(?:niet|nooit|geen)\s+(?:\S+\s+){0,3}?(?:mee|vooruit)\b/, /(?:\b(?:not|never)|n't)\s+(?:\S+\s+){0,2}?think(?:ing|s)?\s+(?:ahead|along)\b/];
const TC_META_GUARDED = [/\b(?:dit|dat|het|zoiets|zulke\s+dingen)\s+(?:moet|had|mag|kun|kan|zou)\s+(?:je|jij)\s+(?:\S+\s+){0,2}?zelf\b/,
  /\bmoet\s+(?:je|jij)\s+(?:\S+\s+){0,3}?zelf\s+(?:\S+\s+)?(?:doen|aanzetten|regelen|bedenken|weten|zien|oppakken|inschakelen|gebruiken|starten|opzetten|draaien)\b/,
  /\bzonder\s+dat\s+ik\s+(?:\S+\s+){0,3}?(?:hoef|moet|hoeft)\s+(?:te\s+)?(?:vragen|zeggen|aangeven|herinneren|aanzetten)\b/, /\bzonder\s+(?:dat\s+ik\s+)?(?:erom|het|dit|dat)\s+te\s+(?:hoeven\s+)?vragen\b/,
  /\bwithout\s+(?:(?:me|my|you)\s+)?(?:having|needing)\s+to\s+(?:ask|tell|remind|say|prompt)\b/, /\bwithout\s+(?:me\s+)?(?:asking|telling|reminding|prompting)\s+(?:you|for\s+it)\b/,
  /\bwithout\s+being\s+(?:asked|told|reminded|prompted)\b/, /\byou\s+(?:should|must|have\s+to|need\s+to|ought\s+to)\s+(?:\S+\s+){0,3}?(?:yourself|on\s+your\s+own|by\s+yourself)\b/,
  /\bi\s+(?:shouldn'?t|should\s+not)\s+(?:have|need)\s+to\s+(?:ask|tell|remind|say)\b/];
const tcNotIk = (re, ikRe) => (s) => re.test(s) && !ikRe.test(s);
const TC_ZET_AAN = /\bzet\b(?:\s+\S+){0,6}?\s+(?:(?:weer|standaard|gewoon|ook)\s+)?(?:aan|open)\b(?!\s+(?:de|het|een|kant|zijde)\b)/;
// order = the cue reported first: the corrective cues before the plain turn-on / use verbs
const TC_WEAK = [
  ['forgot', [/\bvergeet\b(?:\s+\S+){0,2}?\s+niet\b/, /\bniet\s+(?:te\s+)?vergeten\b/, /\b(?:je|jij|u)\s+(?:vergeet|vergat)\b/, /\bvergeet\s+(?:je|jij)\b/,
    tcNotIk(/\bvergeten\b/, /\bik\s+(?:ben|was|had|heb)\s+(?:\S+\s+){0,4}?vergeten\b/), /\b(?:don'?t|do\s+not|never)\s+forget\b/,
    tcNotIk(/\bforg(?:ot|otten|etting)\b/, /\b(?:i|we|i've|we've|i'd)\s+(?:\S+\s+){0,2}?forg(?:ot|otten)\b/)]],
  ['why-not', [/\bwaarom\b(?:\s+\S+){1,7}?\s+(?:niet|geen|nooit)\b/, /\bwhy\b(?:\s+\S+){0,4}?\s+(?:not|didn'?t|don'?t|doesn'?t|aren'?t|isn'?t|wasn'?t|weren'?t|haven'?t|hasn'?t|won'?t|can'?t|couldn'?t|wouldn'?t)\b/]],
  ['should-have', [/\b(?:je|jij)\s+had\b(?:\s+\S+){0,7}?\s+(?:moeten|horen)\b/, /\bhad\s+(?:je|jij)\b(?:\s+\S+){0,7}?\s+(?:moeten|horen)\b/,
    tcNotIk(/\b(?:had|hadden)\b(?:\s+\S+){0,6}?\s+(?:moeten|horen)\s+(?:te\s+)?(?:staan|draaien|lopen|worden|zijn|gebeuren|aan)\b/, /\bik\s+had\b/),
    /\byou\s+(?:should|could|ought\s+to)\s*(?:have|'ve)\b/, /\bshould\s+(?:have|'ve)\s+been\b/, /\byou\s+were\s+supposed\s+to\b/, /\b(?:was|were)\s+supposed\s+to\s+(?:be|run|start)\b/]],
  ['omission', [new RegExp('\\b(?:je|jij|u)\\s+(?:hebt|heeft|had)\\b(?:\\s+\\S+){0,5}?\\s+(?:niet|geen|nooit)\\b(?:\\s+\\S+){0,2}?\\s+' + TC_PART + '\\b'),
    new RegExp('\\b(?:is|zijn|werd|werden|was|waren)\\b(?:\\s+\\S+){0,4}?\\s+(?:niet|geen|nooit)\\b(?:\\s+\\S+){0,2}?\\s+' + TC_PART + '\\b'),
    /\b(?:draaide|draaiden|liep|liepen|stond|stonden|startte|startten)\b(?:\s+\S+){0,3}?\s+(?:geen|niet|nooit)\b/,
    new RegExp("\\b(?:you|it|they|forge)\\s+(?:didn'?t|did\\s+not|never|haven'?t|have\\s+not|hasn'?t|has\\s+not)\\s+(?:\\S+\\s+)?" + TC_EN_VERB + '\\b'),
    /\b(?:was|were)(?:n'?t|\s+not)\s+(?:\S+\s+)?(?:used|enabled|run|started|on|running|spawned|launched)\b/]],
  ['again-omission', [(s, toks) => toks.some((w) => w === 'alweer' || w === 'weer' || w === 'opnieuw' || w === 'again' || w === 'nog_steeds' || w === 'still' || w === 'steeds')
    && (TC_OMIT_RE.test(s) || (/\buit\b/.test(s) && !TC_OFF.some((re) => re.test(s))))]],
  ['never-again', [/\b(?:moet|mag|mogen|moeten)\b(?:\s+\S+){0,3}?\s+niet\s+(?:meer|nog\s+eens|weer|opnieuw)\s+(?:\S+\s+)?(?:gebeuren|voorkomen|voorvallen)\b/, /\bniet\s+meer\s+(?:mag\s+|moet\s+)?gebeuren\b/,
    /\b(?:must|should|can|will)\s*(?:not|never|n'?t)\s+happen\s+again\b/, /\bnever\s+again\b/, /\bdon'?t\s+let\s+(?:this|that|it)\s+happen\s+again\b/]],
  ['cant-you', [(s) => (/\b(?:kan|kun|kunt)\s+(?:je|jij|u)\b(?:\s+\S+){0,2}?\s+(?:niet|nou\s+niet|toch\s+niet)\b/.test(s) || /\b(?:can'?t|cannot|couldn'?t|can\s+not)\s+you\b/.test(s)) && !TC_EXPLAIN_RE.test(s)]],
  ['did-you-also', [/\bheb\s+(?:je|jij|u)\s+(?:\S+\s+)?ook\b(?:\s+\S+){0,8}?\s+(?:gebruikt|bekeken|gecheckt|gecontroleerd|gedraaid|aangezet|getest|meegenomen|gedaan|ingezet|gestart)\b/,
    /\bdid\s+you\s+(?:even|actually)\s+(?:use|run|check|enable|try|test|start)\b/]],
  ['already-said', [/\b(?:ik\s+)?heb\s+(?:ik\s+)?(?:(?:het|dit|dat)\s+)?(?:toch\s+)?(?:al|vaker|eerder|al\s+vaker|al\s+eerder|meerdere\s+keren|al\s+eens|al\s+meerdere\s+keren)\s+(?:\S+\s+)?(?:gezegd|gevraagd|aangegeven|verteld|genoemd)\b/,
    /\b(?:dat|dit|het)\s+(?:zei|vroeg)\s+ik\s+(?:toch\s+)?(?:al|eerder|net)\b/, /\bik\s+(?:zei|vroeg)\s+(?:dat|dit|het)\s+(?:toch\s+)?(?:al|eerder)\b/, /\bzoals\s+ik\s+al\s+(?:zei|vroeg|aangaf)\b/,
    /\bi\s+(?:already|just|have\s+already)\s+(?:said|asked|told\s+you|mentioned)\b/, /\bi'?ve\s+already\s+(?:said|asked|told\s+you|mentioned)\b/, /\bi\s+told\s+you\s+(?:before|already|earlier)\b/, /\bas\s+i\s+(?:already\s+)?(?:said|asked|told\s+you)\b/]],
  ['use', [/\bgebruik\b(?:\s+\S+){0,6}?\s+ook\b/, /\bgebruik\s+ook\b/, /\b(?:je|jij)\s+(?:moet|moest|zou|zal)\s+(?:\S+\s+){0,5}?gebruiken\b/, /\bmoet\s+(?:je|jij)\s+(?:\S+\s+){0,5}?gebruiken\b/,
    /\balso\s+use\b/, /\buse\b(?:\s+\S+){0,4}?\s+(?:too|as\s+well)\b/, /\byou\s+(?:should|must|need\s+to|have\s+to|ought\s+to)\s+(?:\S+\s+)?use\b/]],
  ['toggle-on', [TC_ZET_AAN, /\b(?:aan|open)\s*(?:te\s+)?zetten\b/, /\b(?:aangezet|opengezet|ingeschakeld|geactiveerd)\b/,
    /\binschakel\w*/, /\bactiveer\w*/, /\bturn(?:s|ed|ing)?\b(?:\s+\S+){0,4}?\s+on\b/, /\bswitch(?:es|ed|ing)?\b(?:\s+\S+){0,4}?\s+on\b/, /\benabl(?:e|es|ed|ing)\b/, /\bactivat(?:e|es|ed|ing)\b/, /\bspin(?:s|ning)?\s+up\b/]],
];
// mutation anchors (forge-scribe-classify.test.cjs): each guard below sits on ONE line
const TC_CUE_REQUIRED = true;   // TC-NEED-CUE: a switch word alone is a task, never a correction
const TC_OFF_ALONE = false;     // TC-OFF-NEEDS-OMISSION: "zet ... uit" / "turn off" alone is never a cue

function toggleConfig(cfg) {
  const user = cfg && cfg.toggle_correction && typeof cfg.toggle_correction === 'object' ? cfg.toggle_correction : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { enabled: user.enabled !== false, short: num(user.short_message_chars, TOGGLE_DEFAULTS.short_message_chars),
    max: num(user.max_chars, TOGGLE_DEFAULTS.max_chars), window: num(user.window, TOGGLE_DEFAULTS.window) };
}
/** tcClean(text, max) — lower case, someone else's words dropped (fences, inline code, '>' lines, quoted spans), phrases joined. */
function tcClean(text, max) {
  let s = String(text == null ? '' : text).slice(0, max).replace(/\r\n?/g, '\n');
  s = s.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '$1').replace(/`[^`\n]*`/g, ' ').replace(/^[ \t]*>.*$/gm, ' ');
  s = s.replace(/"[^"\n]{1,400}"|“[^”\n]{1,400}”|„[^”“\n]{1,400}[”“]|«[^»\n]{1,400}»|‘[^’\n]{1,400}’/g, ' ').replace(/(^|[\s(])'[^'\n]{1,200}'(?=[\s.,!?;:)]|$)/g, '$1 ');
  s = s.toLowerCase().replace(/[’‘`]/g, "'");
  for (const [re, to] of TC_JOIN) s = s.replace(re, to);
  return s;
}
const tcToks = (s) => s.split(/[^\p{L}\p{N}_'/-]+/u).filter(Boolean);
/** tcSwitch(ctx) -> the first switch word that counts in this context, or null (ambiguous words yield to product words). */
function tcSwitch(ctx) {
  const toks = tcToks(ctx);
  const firm = toks.find((w) => TC_SWITCH.has(w)) || (TC_SLASH_RE.exec(ctx) || [])[1];
  if (firm) return firm;
  const amb = toks.find((w) => TC_SWITCH_AMBIGUOUS.has(w));
  if (amb && TC_PRODUCT_RE.test(ctx)) return null; // TC-GUARD-PRODUCT
  return amb || null;
}
function tcBurden(s, toks, win) {
  if (TC_ACTOR_RE.test(s)) return false; // TC-GUARD-ACTOR
  const first = toks.some((w) => TC_FIRST.has(w)) || /(?:^|\b(?:en|maar|want|dus|of)\s+)(?:moet|moest)\b/.test(s);
  const youAsk = /\b(?:je|jij|you)\s+(?:\S+\s+){0,2}?(?:vraagt|blijft|vroeg|keep|kept)\b/.test(s);
  if (!first && !youAsk) return false;
  const modal = TC_MODAL_RE.test(s);
  const reps = [], asks = [];
  // "keep"/"kept" repeats only in the complaint form ("keep asking", "keep having to"), never "keep going" / "keep it on"
  const keepOk = (i) => (toks[i] !== 'keep' && toks[i] !== 'kept') || TC_KEEP_NEXT.has(toks[i + 1] || '');
  toks.forEach((w, i) => { if ((TC_REP_STRONG.has(w) && keepOk(i)) || (modal && TC_REP_WEAK.has(w))) reps.push(i); if (TC_ASK.has(w)) asks.push(i); });
  if (reps.some((r) => asks.some((a) => a !== r && Math.abs(a - r) <= win))) return true;
  return first && reps.length > 0 && TC_ZET_AAN.test(s); // "ik zet het steeds zelf aan"
}
function tcStopAsk(s) {
  if (TC_ACTOR_RE.test(s) || TC_PRODUCT_RE.test(s)) return false;
  const re = /(?:^|[^\p{L}'])vraag\s+(?:(?:ook|dan|nou|gewoon|toch|me|mij|het|dat|dit|er)\s+){0,2}(?:niet|nooit)\s+(?:meer|steeds|telkens|elke_keer|opnieuw|om|of|nog)\b/gu;
  let m;
  while ((m = re.exec(s)) !== null) { // "vraag" as a noun ("de vraag niet meer stellen") is no imperative
    const before = (/(\S+)\s*$/.exec(s.slice(0, m.index + m[0].indexOf('vraag'))) || [])[1];
    if (!before || !TC_DETERMINERS.has(before)) return true;
  }
  return TC_STOP_ASK.some((r) => r.test(s));
}
function tcMeta(s) {
  if (TC_META_FREE.some((r) => r.test(s))) return true;
  return !TC_ACTOR_RE.test(s) && !TC_PRODUCT_RE.test(s) && TC_META_GUARDED.some((r) => r.test(s));
}
const tcTest = (p, s, toks) => (typeof p === 'function' ? p(s, toks) : p.test(s));
/** toggleCorrection(text, cfg) — see TOGGLE CORRECTIONS above. Pure. */
function toggleCorrection(text, cfg) {
  const T = toggleConfig(cfg);
  const none = { tagged: false, tag: null, cue: null, strong: false, switch_word: null, sentence: null };
  if (!T.enabled) return none;
  const all = tcClean(text, T.max);
  if (!/\p{L}/u.test(all)) return none;
  const short = all.replace(/\s+/g, ' ').trim().length <= T.short;
  let weakHit = null;
  for (const sen of splitSentences(all)) {
    const s = sen.text.replace(/\s+/g, ' ');
    const toks = tcToks(s);
    const strong = tcBurden(s, toks, T.window) ? 'burden' : tcStopAsk(s) ? 'stop-asking' : tcMeta(s) ? 'meta' : null;
    if (strong) return { tagged: true, tag: TOGGLE_TAG, cue: strong, strong: true, switch_word: tcSwitch(short ? all : s), sentence: s.slice(0, 80) };
    if (weakHit) continue;
    let cue = (TC_WEAK.find(([, ps]) => ps.some((p) => tcTest(p, s, toks))) || [])[0] || null;
    if (!cue && TC_OFF_ALONE && TC_OFF.some((re) => re.test(s))) cue = 'turn-off';
    if (!cue && !TC_CUE_REQUIRED) cue = 'switch-only';
    if (!cue) continue;
    const sw = tcSwitch(short ? all : s);
    if (!sw) continue; // TC-NEED-SWITCH
    weakHit = { tagged: true, tag: TOGGLE_TAG, cue, strong: false, switch_word: sw, sentence: s.slice(0, 80) };
  }
  return weakHit || none;
}

module.exports = { loadConfig, classify, splitSentences, scoreText, pickClass, authorizes, sharedListAck, idRanges, stripIntent, negationRe, machineSkip, stripLeadingHarness, HARNESS_LEAD_TAGS, clausesOf, isQuestion, CLASSES, DEFAULT_CONFIG, FORGE_TOOL_SUBCOMMANDS,
  findRepeats, repeatTokens, repeatScore, repeatCue, repeatEligible, repeatConfig, repeatDistinctive, repeatStatusQuestion,
  REPEAT_DEFAULTS, GENERIC_REPEAT_WORDS,
  // WP I.8c: toggle corrections (a TAG on owner messages, never a class)
  toggleCorrection, toggleConfig, TOGGLE_TAG, TOGGLE_MARK, TOGGLE_DEFAULTS };
