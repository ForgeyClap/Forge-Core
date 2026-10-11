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
 *   authorizes(text, rid, intent, cfg) -> { ok, how, sentence } | { ok:false, reason }   (Codex R3 SC-01, R5 SV-01)
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
 *     several ids) is refused when the sentence holds a contrast cut or a negation anywhere. Ranges are never expanded.
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
 *  residue and the sentence falls back to the one-item binding below. Ranges are never expanded. */
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
    const named = ridRe.test(sen.text);
    const batchPhrase = phrases.find((ph) => ph && low.includes(String(ph).toLowerCase()));
    if (!named && !batchPhrase) continue;
    const what = named ? 'names ' + rid : 'holds the batch phrase ' + JSON.stringify(batchPhrase);
    if (isQuestion(sen.text, cfg)) return no(sen.text, what + ' but is a question');
    if (R.conditional.test(sen.text)) return no(sen.text, what + ' but is conditional (' + (sen.text.match(R.conditional) || [''])[0].trim() + ')');
    if (named && intent === 'ack' && sharedListAck(sen.text, cfg)) { // a list of ids sharing ONE affirmative predicate
      if (!affirm) affirm = { ok: true, how: 'list', sentence: sen.text.slice(0, 200) };
      continue;
    }
    const clauses = clausesOf(sen.text, cfg, intent);
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
          if (anchor < 0) return no(sen.text, 'names ' + rid + ' without an act bound to it (a bare mention, or across a contrast word)');
        }
        // an act shared with other ids (a bare list item, or a clause naming several ids) never survives an exception
        // or a negation anywhere in the sentence ("R-0002 en R-0003 akkoord, maar R-0004 niet" approves none of them)
        const shared = anchor !== i || (clauses[anchor].text.match(/\bR-\d+\b/gi) || []).length > 1;
        if (shared && (clauses.some((x) => x.sep === 'contrast') || R.neg.test(stripIntent(sen.text, intent, cfg).replace(/\bR-\d+\b/gi, ' ')))) {
          return no(sen.text, 'names ' + rid + ' in a list that shares one act with other ids, and the sentence carries an exception or a negation — a shared act never has exceptions');
        }
        const why = clauseVerdict(clauses[anchor].text, intent, cfg);
        if (why) return no(sen.text, 'names ' + rid + ' in the clause ' + JSON.stringify(clauses[anchor].text.slice(0, 80)) + ', which is not an affirmative ' + intent + ' (' + why + ')');
      }
    } else {
      if (clauses.some((x) => x.sep === 'contrast')) return no(sen.text, what + ' but carries an exception (a contrast word, dash or parenthesis) — a batch act never has exceptions');
      const cl = clauses.find((x) => x.text.toLowerCase().includes(String(batchPhrase).toLowerCase())) || { text: sen.text };
      const why = clauseVerdict(cl.text, intent, cfg);
      if (why) return no(sen.text, what + ' but is not an affirmative ' + intent + ' (' + why + ')');
    }
    if (!affirm) affirm = { ok: true, how: named ? 'rid' : 'batch', sentence: sen.text.slice(0, 200) };
  }
  return affirm || { ok: false, reason: 'no sentence names ' + rid + ' or a batch ' + intent + ' phrase' };
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

module.exports = { loadConfig, classify, splitSentences, scoreText, pickClass, authorizes, sharedListAck, stripIntent, negationRe, machineSkip, clausesOf, isQuestion, CLASSES, DEFAULT_CONFIG, FORGE_TOOL_SUBCOMMANDS,
  findRepeats, repeatTokens, repeatScore, repeatCue, repeatEligible, repeatConfig, repeatDistinctive, repeatStatusQuestion,
  REPEAT_DEFAULTS, GENERIC_REPEAT_WORDS };
