#!/usr/bin/env node
'use strict';
/**
 * forge-text-normalize.cjs — a tiny shared Dutch/English text normaliser (work package I.8a).
 * Zero dependencies, deterministic, offline. Used by forge-domain-discovery.cjs (classify), forge-quality.cjs
 * (compileMissionProfile cross labels) and, through the same API, by other Forge lanes.
 *
 * WHY: whole-word matching missed every Dutch plural and compound ("wachtwoorden", "sessies", "inlogflow",
 * "spraakassistent", "e-learningsite"), which the intelligence evals measured as a blind spot for a Dutch owner.
 * Plain substring matching is no answer either: it already chose a wrong playbook before (F-15: "producten" in
 * "softwareproducten", "port" in "support"). So this module is CONSERVATIVE on purpose:
 *  - plural stripping only (no -ing/-heid/-lijk morphology), with guards against Dutch verbs ("installeren" never
 *    becomes "installer", "spelen" becomes "speel" and never "spel"), and the word itself always stays a candidate;
 *  - compound matching only at the two compound positions (the HEAD at the end, the MODIFIER at the start, never in
 *    the middle: "port" must not match "support", "transport" or "sportschool"), only for stems of >= 5 letters
 *    (or a documented 4-letter allow-list), only when the other part has >= 3 letters, and never for a word on the
 *    documented stop-list of lexicalised look-alikes ("toespraak", "opposite");
 *  - (2.9c) two more documented stop-lists for false friends of the plural/inflection rules: INFLECTION_STOP (words
 *    that look like an -er/-ing form but are a word of their own: "platformer" is not a platform, "merger" not a merge)
 *    and PLURAL_ONLY (plural terms whose singular is another word: "rechten" is not "recht", "sources" not "source",
 *    "lanes" not "lane"; such a term is its own stem and matches only itself, its compounds included).
 *
 * STABLE API (other lanes require it; keep these signatures):
 *   normalize(text)            -> string   lowercase, accents folded (é -> e), curly quotes straightened, one space
 *   stems(text)                -> string[] the canonical stem of every word token, in order, unique
 *   hasStem(text, stem, opts?) -> boolean  does any word of text carry this stem? Plural forms match; a trailing
 *                                          '*' means "starts with"; a multi-word stem matches as a phrase; compound
 *                                          parts match by the rules above unless opts.compound === false
 * Secondary helpers (also stable): tokenize, stem, candidates, compoundEligible, compoundPosition, matcher,
 * englishForms, COMPOUND_MIN, COMPOUND_REST_MIN, SHORT_COMPOUND_ALLOW, COMPOUND_STOP, INFLECTION_STOP, PLURAL_ONLY.
 */

const COMPOUND_MIN = 5;        // a compound part must be at least this long ...
const COMPOUND_REST_MIN = 3;   // ... and the rest of the word at least this long ("afspraak" = af+spraak: no)
/** 4-letter stems that may still match as a compound part, each with a reason (the stop-list holds their false
 *  friends). Anything else under 5 letters is whole-word only: "port", "shop", "spel", "auth", "sync" all have
 *  too many look-alikes ("support", "workshop", "voorspel", "authority", "async"). */
const SHORT_COMPOUND_ALLOW = new Set([
  'site', // the head of Dutch website compounds: e-learningsite, cursussite, verhuursite, fotosite
]);
/** Words that look like a compound of a lexicon stem but are a word of their own. Checked against every plural
 *  candidate of a token, before any compound match. */
const COMPOUND_STOP = new Set([
  // "-spraak" words that mean speech/statement/claim, not a voice product
  'toespraak', 'uitspraak', 'tegenspraak', 'aanspraak', 'samenspraak', 'wanspraak', 'spraakmakend', 'spraakmakende',
  // English "-site" words that are not a website
  'opposite', 'composite', 'requisite', 'prerequisite', 'exquisite', 'parasite', 'apposite', 'campsite',
]);
/** (2.9c follow-up) Words that LOOK like an English -er/-ers/-ing inflection of a shorter term but are a word of their
 *  own. englishForms() never yields them, so they only match a term that names them exactly. Each entry was a real
 *  false friend of hasStem: */
const INFLECTION_STOP = new Set([
  'platformer', 'platformers', 'platforming', // a game genre ("a 2D platformer"), not a platform (no PRD, no cross-platform)
  'merger', 'mergers',                        // a company merger, not a git merge
]);
/** (2.9c follow-up) Plural terms whose singular is ANOTHER word: such a term is its own stem and matches only itself
 *  (and compounds that end or start with the plural itself: "toegangsrechten", "rechtenbeheer"), never the singular
 *  and never a compound of the singular ("rechtbank"). */
const PLURAL_ONLY = new Set([
  'rechten',  // (access) rights / law studies; "recht" = law, a right, straight ("recht toe recht aan", "rechtbank")
  'sources',  // cited sources (RAG, research); "source" = open source, source code
  'lanes',    // Forge's parallel lanes; "lane" = a road, swim or bowling lane
]);
const CONS = 'b-df-hj-np-tv-z';
const RE_DOUBLE = new RegExp('([' + CONS + '])\\1$');
const RE_OPEN = new RegExp('(?:^|[^aeiou])([aeou])[' + CONS + ']$');

/** normalize(text) -> lowercase, accent-folded, quotes straightened, whitespace collapsed. Punctuation is kept so
 *  phrase and boundary rules (".exe", "make.com", "e-commerce") still work on the result. */
function normalize(text) {
  return String(text == null ? '' : text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/** tokenize(text) -> [{raw, start, end}] word tokens of normalize(text) (letters/digits, plus a Dutch "'s"
 *  plural: "video's" is one token). Offsets index into normalize(text). Hyphens split ("e-learningsite" ->
 *  "e", "learningsite"). */
function tokenize(text) {
  const t = normalize(text);
  const out = [];
  const re = /[a-z0-9]+(?:'s(?![a-z0-9]))?/g;
  let m;
  while ((m = re.exec(t))) out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Dutch -en plural: "wachtwoorden" -> "wachtwoord", "afspraken" -> "afspraak" (open syllable: the vowel doubles
 *  back), "modellen" -> "model", "inloggen" -> "inlog". Refused when the rest ends in a plain "-er" (verbs such as
 *  "installeren", "leveren" and -er nouns, which take -s) or is shorter than 4 letters ("boten" never gives "bot"). */
function stripEn(w) {
  if (w.length < 5 || !w.endsWith('en')) return null;
  let c = w.slice(0, -2);
  if (c.endsWith('er') && !/[ie]er$/.test(c)) return null;
  if (RE_DOUBLE.test(c)) c = c.slice(0, -1);
  else if (RE_OPEN.test(c)) c = c.slice(0, -1) + c.slice(-2, -1) + c.slice(-1);
  return c.length >= 4 ? c : null;
}
/** Dutch -eren plural: "kinderen" -> "kind", "liederen" -> "lied". Only when -en was refused (so "formulieren"
 *  stays "formulier") and the rest keeps 4+ letters (so the verb "leveren" is left alone). */
function stripEren(w) { return w.length >= 8 && w.endsWith('eren') && !stripEn(w) ? w.slice(0, -4) : null; }
/** -s plural (Dutch "sessies" -> "sessie", English "bots" -> "bot"); not after ss/us/is ("process", "status"). */
function stripS(w) { return w.length >= 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : null; }
/** English -es after a sibilant: "classes" -> "class", "boxes" -> "box". */
function stripEs(w) { return w.length >= 5 && /(s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2) : null; }
/** English -ies: "categories" -> "category". */
function stripIes(w) { return w.length >= 5 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : null; }
function stripApos(w) { return w.endsWith("'s") ? w.slice(0, -2) : null; }

/** stem(word) -> ONE canonical stem: the first plural rule that applies ('s, -en, -eren, -es, -s), else the word.
 *  Used as the lexicon key, so "betaling" and "betalingen" are one piece of evidence. */
function stem(word) {
  const w = normalize(word).replace(/[^a-z0-9']/g, '');
  if (!w) return '';
  if (PLURAL_ONLY.has(w)) return w; // "rechten" is its own stem: its singular "recht" is another word
  const a = stripApos(w); if (a) return a;
  return stripEn(w) || stripEren(w) || stripEs(w) || stripS(w) || w;
}
/** candidates(word) -> the word and every plural-stripped form that passes its own guard (the word always stays a
 *  candidate). A lexicon stem matches a token when it is one of the token's candidates. */
function candidates(word) {
  const w = normalize(word).replace(/[^a-z0-9']/g, '');
  if (!w) return [];
  const a = stripApos(w);
  const base = a || w;
  const out = [base];
  for (const c of [stripEn(base), stripEren(base), stripEs(base), stripIes(base), stripS(base)]) if (c && !out.includes(c)) out.push(c);
  return out;
}
/** englishForms(term) -> the inflected English surface forms of a single-word lexicon term (the light inflection
 *  forge-domain-discovery always had): plural for every term; -ing/-er/-ers/-ed only for terms of 4+ letters, so
 *  "bot" never matches the Dutch "boter". "scrape" -> scraping/scraper/scraped. Never a word on INFLECTION_STOP
 *  ("platform" never gives "platformer"), and a PLURAL_ONLY term never gives its singular ("sources" not "source"). */
function englishForms(term) {
  const k = normalize(term);
  const out = new Set();
  if (!/^[a-z]+$/.test(k)) return out;
  out.add(k + 's'); out.add(k + 'es');
  if (k.length >= 4) {
    for (const suf of ['ing', 'er', 'ers', 'ed']) out.add(k + suf);
    if (k.endsWith('e')) for (const suf of ['ing', 'er', 'ers', 'ed']) out.add(k.slice(0, -1) + suf);
  }
  if (k.length > 3 && k.endsWith('s') && !PLURAL_ONLY.has(k)) out.add(k.slice(0, -1));
  for (const f of INFLECTION_STOP) out.delete(f);
  return out;
}

/** compoundEligible(stem) -> may this stem match as part of a compound word? */
function compoundEligible(s) {
  return /^[a-z]+$/.test(s) && (s.length >= COMPOUND_MIN || SHORT_COMPOUND_ALLOW.has(s));
}
/** compoundPosition(token, stem) -> 'head' (the stem ends the word: "webwinkel" / winkel), 'modifier' (the stem
 *  starts it: "inlogflow" / inlog) or null. Never in the middle, never for a stop-list word, never when the rest is
 *  shorter than COMPOUND_REST_MIN or the stem is not compound-eligible (an INFLECTION_STOP word is never split
 *  either: "platformers" is not platform+ers). A plain plural of the stem is not a compound
 *  (plural matching handles it). `cands` (optional) = candidates(token), precomputed by a caller that checks many
 *  stems against one word. */
function compoundPosition(token, s, cands0) {
  if (!compoundEligible(s)) return null;
  const cands = Array.isArray(cands0) ? cands0 : candidates(token);
  if (!cands.length || cands.includes(s) || cands.some((c) => COMPOUND_STOP.has(c) || INFLECTION_STOP.has(c))) return null;
  if (cands.some((c) => c.length - s.length >= COMPOUND_REST_MIN && c.endsWith(s))) return 'head';
  const raw = cands[0];
  if (raw.length - s.length >= COMPOUND_REST_MIN && raw.startsWith(s)) return 'modifier';
  return null;
}

/** parseStem(stemArg) -> {tokens: [stems], prefix: lastTokenPrefix|null, raw: [raw tokens]} */
function parseStem(arg) {
  let s = normalize(arg);
  const prefix = s.endsWith('*');
  if (prefix) s = s.slice(0, -1);
  const raw = tokenize(s).map((x) => x.raw);
  return { raw, tokens: raw.map(stem), prefix: prefix && raw.length ? raw[raw.length - 1] : null };
}
/** one token against one stem position. opts.compound: allow compound parts (single-word stems only). */
function tokenHas(tok, st, raw, opts) {
  const cands = candidates(tok);
  if (cands.includes(st) || cands.includes(raw) || englishForms(raw).has(tok)) return true;
  return !!(opts && opts.compound && compoundPosition(tok, st));
}

/** matcher(text) -> {tokens, has(stem, opts)} — tokenizes once for many lookups (forge-quality cross labels). */
function matcher(text) {
  const toks = tokenize(text).map((x) => x.raw);
  function has(arg, opts) {
    const o = Object.assign({ compound: true }, opts);
    const p = parseStem(arg);
    const n = p.raw.length;
    if (!n) return false;
    for (let i = 0; i + n <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < n && ok; j++) {
        const last = j === n - 1;
        if (last && p.prefix) ok = toks[i + j].startsWith(p.prefix);
        else ok = tokenHas(toks[i + j], p.tokens[j], p.raw[j], { compound: o.compound && n === 1 });
      }
      if (ok) return true;
    }
    return false;
  }
  return { tokens: toks, has };
}
/** hasStem(text, stem, opts?) -> boolean (see the header). */
function hasStem(text, s, opts) { return matcher(text).has(s, opts); }
/** stems(text) -> canonical stems of the word tokens, in order of first appearance, unique. */
function stems(text) {
  const out = [];
  for (const t of tokenize(text)) { const s = stem(t.raw); if (s && !out.includes(s)) out.push(s); }
  return out;
}

module.exports = {
  normalize, stems, hasStem,
  tokenize, stem, candidates, englishForms, compoundEligible, compoundPosition, matcher,
  COMPOUND_MIN, COMPOUND_REST_MIN, SHORT_COMPOUND_ALLOW, COMPOUND_STOP, INFLECTION_STOP, PLURAL_ONLY,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'stems' && rest.length) { console.log(JSON.stringify(stems(rest.join(' ')))); process.exitCode = 0; }
  else if (cmd === 'has' && rest.length >= 2) { const r = hasStem(rest.slice(0, -1).join(' '), rest[rest.length - 1]); console.log(r ? 'yes' : 'no'); process.exitCode = r ? 0 : 1; }
  else { console.error('usage: forge-text-normalize.cjs stems "<text>" | has "<text>" <stem>   (exit 0 yes / 1 no / 2 usage)'); process.exitCode = 2; }
}
