'use strict';
/**
 * forge-domain-deliverable.cjs — WP I.10, a helper of forge-domain-discovery.cjs (zero dependencies, no I/O).
 * Two signals a bag of words cannot give, both read from the catalog (domain-catalog.json, see its deliverable_rule
 * _doc and _doc_classifier):
 *  - sequences: a verb then its object within max_gap words ("train a churn model" is ML; "a model train club" is not);
 *  - the deliverable rule: the phrase after a build verb names what the request BUILDS ("Build an MCP server that lets
 *    Claude look up orders in our shop" -> "an mcp server"). When it holds a `deliverable_terms` artifact of domain D and
 *    another domain scores at least as high, that domain's WEAK words (router- or description-only, never a reviewed
 *    catalog keyword) outside the phrase name the data the artifact touches: they are reported as context_terms, not
 *    counted. Without a conflict nothing changes.
 * The matchers (wordsFor, phraseStarts, termMatches) are passed in by the classifier, so there is no require cycle.
 */

/** sequenceProblem(q, N) -> null | why a catalog `sequences` entry is malformed (N = forge-text-normalize.cjs). */
function sequenceProblem(q, N) {
  const words = (l) => Array.isArray(l) && l.length > 0 && l.every((w) => typeof w === 'string' && /^[a-z0-9À-ɏ]+$/.test(N.normalize(w)));
  if (!q || typeof q !== 'object' || typeof q.label !== 'string' || !q.label.trim()) return 'needs a label';
  if (!words(q.first) || !words(q.then)) return 'needs first[] and then[]: non-empty lists of single words';
  if (!(Number.isInteger(q.max_gap) && q.max_gap >= 0 && q.max_gap <= 5)) return 'max_gap must be an integer 0..5';
  return null;
}
/** sequenceEntries(list, d, N, weight, problems) -> the lexicon entries (kind 'sequence', key 'seq:<label>') of a domain's
 *  valid `sequences`; each malformed one is pushed to problems as "<d>: sequences[i] <why>" and skipped. */
function sequenceEntries(list, d, N, weight, problems) {
  const out = [];
  list.forEach((q, i) => {
    const p = sequenceProblem(q, N);
    if (p) { problems.push(d + ': sequences[' + i + '] ' + p); return; }
    out.push({ kind: 'sequence', key: 'seq:' + q.label, label: q.label, first: new Set(q.first.map(N.normalize)), then: new Set(q.then.map(N.normalize)), gap: q.max_gap, weight, sources: ['catalog'], stem: false, consumes: false, prefix: null });
  });
  return out;
}
/** sequenceHit(toks, e, excluded) -> does a `first` word come before a `then` word within e.gap words in between? A token
 *  matches by its raw form or a plural candidate; a token blanked for the domain (excluded) never matches. */
function sequenceHit(toks, e, excluded) {
  const is = (i, set) => !excluded.has(i) && (set.has(toks[i].raw) || [...toks[i].w.cands].some((c) => set.has(c)));
  for (let i = 0; i < toks.length; i++) {
    if (!is(i, e.first)) continue;
    for (let j = i + 1; j <= Math.min(toks.length - 1, i + 1 + e.gap); j++) if (is(j, e.then)) return true;
  }
  return false;
}

/** deliverableRule(def, problems, N) -> {verbs, finals, articles, boundaries, max} | null: the catalog's top-level rule. */
function deliverableRule(def, problems, N) {
  if (def === undefined) return null;
  const set = (v, name) => { if (!Array.isArray(v) || !v.every((w) => typeof w === 'string')) { problems.push('deliverable_rule.' + name + ' must be a list of words'); return new Set(); } return new Set(v.map(N.normalize)); };
  const max = def && Number.isInteger(def.max_words) && def.max_words >= 1 && def.max_words <= 8 ? def.max_words : (problems.push('deliverable_rule.max_words must be an integer 1..8'), 6);
  return { verbs: set(def && def.verbs, 'verbs'), finals: set(def && def.final_verbs, 'final_verbs'), articles: set(def && def.articles, 'articles'), boundaries: set(def && def.boundaries, 'boundaries'), max };
}
/** clauseBreak(norm, doc, i) -> is there sentence or clause punctuation between token i-1 and token i? */
const clauseBreak = (norm, doc, i) => i > 0 && /[,.;:!?()]/.test(norm.slice(doc.toks[i - 1].end, doc.toks[i].start));
/** deliverablePhrases(doc, norm, rule) -> [[a, b)] token ranges that name what is built: the words after a build verb up to
 *  a boundary word or punctuation, and (Dutch verb-final) the words between an article and a final build verb ("een
 *  MCP-server bouwen"). At most rule.max words each. */
function deliverablePhrases(doc, norm, rule) {
  const toks = doc.toks;
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].raw;
    if (rule.verbs.has(w)) {
      let b = i + 1;
      while (b < toks.length && b - i - 1 < rule.max && !rule.boundaries.has(toks[b].raw) && !clauseBreak(norm, doc, b)) b++;
      if (b > i + 1) out.push([i + 1, b]);
    } else if (rule.finals.has(w)) {
      let a = i - 1;
      while (a >= 0 && i - a <= rule.max && !rule.articles.has(toks[a].raw) && !rule.boundaries.has(toks[a].raw) && !clauseBreak(norm, doc, a + 1)) a--;
      if (a >= 0 && rule.articles.has(toks[a].raw) && a + 1 < i) out.push([a + 1, i]);
    }
  }
  return out;
}
/** lastIn(doc, e, span, M) -> the last token index inside [a, b) where lexicon entry e matches, or -1. */
function lastIn(doc, norm, e, span, M) {
  const [a, b] = span;
  if (e.kind === 'word') return Math.max(-1, ...[...M.wordsFor(doc, e)].flatMap((w) => w.idxs.filter((i) => i >= a && i < b)));
  if (e.kind === 'phrase') return Math.max(-1, ...M.phraseStarts(doc, e).filter((i) => i >= a && i + e.tokens.length <= b).map((i) => i + e.tokens.length - 1));
  if (e.kind === 'legacy') return b > a && M.termMatches(' ' + norm.slice(doc.toks[a].start, doc.toks[b - 1].end) + ' ', e.term) ? b - 1 : -1;
  return -1;
}
/** deliverableOf(doc, norm, lex, matched, M) -> {domain, term, phrase, span} | null: the first deliverable phrase that holds
 *  a counted deliverable term; with two artifact domains in one phrase the right-most term (the head noun) wins. */
function deliverableOf(doc, norm, lex, matched, M) {
  if (!lex.deliverable) return null;
  for (const span of deliverablePhrases(doc, norm, lex.deliverable)) {
    let best = null;
    for (const [d, m] of Object.entries(lex.meta || {})) {
      for (const key of m.deliverable || []) {
        if (!matched[d] || !matched[d].has(key)) continue;
        const pos = lastIn(doc, norm, lex.domains[d].get(key), span, M);
        if (pos >= 0 && (!best || pos > best.pos || (pos === best.pos && d < best.domain))) best = { domain: d, term: matched[d].get(key), pos };
      }
    }
    if (best) return { domain: best.domain, term: best.term, span, phrase: doc.toks.slice(span[0], span[1]).map((t) => t.raw).join(' ') };
  }
  return null;
}
/** applyDeliverable({doc, norm, lex, matched, doms, res, tally, M}) -> res, re-tallied after demoting context words when
 *  the deliverable's domain is in a conflict, and carrying `deliverable` {domain, term, phrase, context_terms}. `matched`
 *  (domain -> Map key -> label) is the classifier's own working map; tally() recomputes the scores from it. */
function applyDeliverable(c) {
  const deliv = deliverableOf(c.doc, c.norm, c.lex, c.matched, c.M);
  if (!deliv) return c.res;
  let res = c.res;
  const context = {};
  if (c.doms.some((d) => d !== deliv.domain && res.scores[d] >= res.scores[deliv.domain])) {
    for (const d of c.doms) {
      if (d === deliv.domain || !c.matched[d]) continue;
      for (const [key, label] of [...c.matched[d]]) {
        const e = c.lex.domains[d].get(key);
        if (e.sources.includes('catalog') || lastIn(c.doc, c.norm, e, deliv.span, c.M) >= 0) continue;
        c.matched[d].delete(key);
        (context[d] = context[d] || []).push(label);
      }
    }
    res = c.tally();
  }
  res.deliverable = { domain: deliv.domain, term: deliv.term, phrase: deliv.phrase, context_terms: context };
  return res;
}

module.exports = { sequenceProblem, sequenceEntries, sequenceHit, deliverableRule, deliverablePhrases, deliverableOf, applyDeliverable };
