'use strict';
/**
 * doctor/checks-tools.cjs — one module of forge-doctor.cjs (W2-WIRE): ecc_path and citations.
 * Rule "added = installed + wired + used + guarded": two zero-dependency research tools are only usable while they
 * still do their one job, so the doctor runs that job cheaply (no spawn, no network):
 *   ecc_path  — forge-ecc-path.cjs. Applicable only while ECC is installed (<home>/.claude/skills/ecc is a folder);
 *               red when resolveSkill('skill-stocktake') or resolveSkill('skill-scout') returns null, or listSkills()
 *               finds 0 skills with source 'ecc'. A fresh machine without ECC gets a visible skip. The machine is only
 *               read for this doctor's own project root or an explicit opts.home, so a fixture root never reads it.
 *   citations — forge-citations.cjs. A fixed sample source in a throwaway temp folder: a real quote must come back
 *               'verified' and the same quote with its last word cut mid-way must come back 'mismatch' (the word
 *               boundary rule), and checkRefs (the refs command) must find the planted undefined marker, unused
 *               reference and malformed DOI in a fixed sample (W2-CITE-MACHINE). A stored mismatch in any
 *               <root>/.claude/forge-runs/<run>/citations.jsonl, or a ledger that does not load, is a printed warning, never red: a research draft may hold one until it is fixed.
 * Both are ENFORCED in the development tree; elsewhere a failure is labelled (ok:true, enforced:false), like
 * skill_adapters. opts.loadTool(name) is injectable so tests can hand in a broken tool without editing a real one.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BIN_DIR } = require('./context.cjs');
const { readDevTreeMarker } = require('./checks-hygiene.cjs');

const ECC_REQUIRED_SKILLS = Object.freeze(['skill-stocktake', 'skill-scout']);
const CITATION_SAMPLE = 'The doctor runs every enforced check in a fixed order and prints one line for each check.\n';
const CITATION_GOOD_QUOTE = 'runs every enforced check in a fixed order';
const CITATION_CUT_QUOTE = 'runs every enforced check in a fix'; // "fixed" cut mid-way: must never verify
const REFS_SAMPLE = 'A claim [1] and [3].\nSee doi:10.12/x for it.\n\n## References\n[1] One.\n[2] Two.\n';
const REFS_EXPECTED = 'malformed_doi:10.12/x,undefined_marker:3,unused_reference:2';
const MAX_WARN_ITEMS = 5;

function defaultLoadTool(name) { return require(path.join(BIN_DIR, name)); }
function isOwnProjectRoot(root) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* keep resolved */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(root) === norm(path.join(__dirname, '..', '..', '..'));
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function loadTool(o, name) {
  try { return { mod: (o.loadTool || defaultLoadTool)(name), error: null }; } catch (e) { return { mod: null, error: name + ' does not load: ' + ((e && e.message) || e) }; }
}
/** finish(dev, base, problems) -> the result shape shared by both checks. */
function finish(dev, base, problems) {
  const reason = problems.length ? problems.join('; ') + (dev ? '' : ' (not enforced outside the development tree)') : '';
  return Object.assign(base, { ok: dev ? problems.length === 0 : true, enforced: dev, problems, reason });
}

/** eccPathCheck(root, opts) -> {ok, applicable, enforced, resolved{}, ecc_skills, problems[], reason, ms}.
 *  opts: {home (the USER home, as forge-ecc-path takes it), loadTool}. */
function eccPathCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dev = readDevTreeMarker(root).valid;
  const home = o.home || (isOwnProjectRoot(root) ? os.homedir() : null);
  if (!home) return { ok: true, applicable: false, enforced: dev, problems: [], ms: 0, reason: 'not this doctor\'s own project root — the machine skill roots are not read' };
  const eccDir = path.join(home, '.claude', 'skills', 'ecc');
  if (!isDir(eccDir)) return { ok: true, applicable: false, enforced: dev, problems: [], ms: Date.now() - t0, reason: 'skipped: ECC not installed (no ' + eccDir + ') — nothing to resolve' };
  const base = { applicable: true, resolved: {}, ecc_skills: 0 };
  const { mod, error } = loadTool(o, 'forge-ecc-path.cjs');
  if (!mod) return Object.assign(finish(dev, base, [error]), { ms: Date.now() - t0 });
  const problems = [];
  const ropts = { home, project: root };
  try {
    for (const name of ECC_REQUIRED_SKILLS) {
      const hit = mod.resolveSkill(name, ropts);
      if (hit && hit.path) base.resolved[name] = { source: hit.source, path: hit.path };
      else problems.push('resolveSkill(\'' + name + '\') returned null although ECC is installed at ' + eccDir);
    }
    base.ecc_skills = mod.listSkills(ropts).filter((s) => s && s.source === 'ecc').length;
    if (base.ecc_skills === 0) problems.push('listSkills() found 0 ecc skills under ' + eccDir);
  } catch (e) { problems.push('forge-ecc-path.cjs threw: ' + ((e && e.message) || e)); }
  return Object.assign(finish(dev, base, problems), { ms: Date.now() - t0 });
}

/** ledgerWarnings(root, mod) -> {ledgers, warn}: stored statuses only (no re-check, no source reads). */
function ledgerWarnings(root, mod) {
  const runsDir = path.join(root, '.claude', 'forge-runs');
  let runs = [];
  try { runs = fs.readdirSync(runsDir); } catch { return { ledgers: 0, warn: '' }; }
  let ledgers = 0;
  const items = [];
  for (const run of runs.sort()) {
    const file = path.join(runsDir, run, 'citations.jsonl');
    if (!fs.existsSync(file)) continue;
    ledgers++;
    let recs;
    try { recs = mod.loadLedger(file); } catch (e) { items.push(run + ': unreadable (' + ((e && e.message) || e).replace(/:\s.*$/, '') + ')'); continue; }
    for (const r of recs) if (r && r.status === 'mismatch') items.push(run + ': ' + r.claim_id);
  }
  if (!items.length) return { ledgers, warn: '' };
  return { ledgers, warn: items.length + ' stored mismatch/unreadable ledger item(s): ' + items.slice(0, MAX_WARN_ITEMS).join(', ') + (items.length > MAX_WARN_ITEMS ? ', +' + (items.length - MAX_WARN_ITEMS) + ' more' : '') };
}

/** citationsCheck(root, opts) -> {ok, applicable, enforced, self_test{good, broken}, ledgers, warn, problems[], reason, ms}.
 *  opts: {loadTool}. */
function citationsCheck(root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dev = readDevTreeMarker(root).valid;
  const base = { applicable: true, self_test: {}, ledgers: 0 };
  const { mod, error } = loadTool(o, 'forge-citations.cjs');
  if (!mod) return Object.assign(finish(dev, base, [error]), { ms: Date.now() - t0 });
  const problems = [];
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-cit-'));
    fs.writeFileSync(path.join(tmp, 'source.txt'), CITATION_SAMPLE);
    const ev = (id, quote) => mod.evaluateClaim({ claim_id: id, source_path: 'source.txt', quote }, { root: tmp });
    base.self_test.good = (ev('c1', CITATION_GOOD_QUOTE) || {}).status;
    base.self_test.broken = (ev('c2', CITATION_CUT_QUOTE) || {}).status;
    if (base.self_test.good !== 'verified') problems.push('the real quote "' + CITATION_GOOD_QUOTE + '" was ' + base.self_test.good + ', expected verified');
    if (base.self_test.broken !== 'mismatch') problems.push('the cut quote "' + CITATION_CUT_QUOTE + '" was ' + base.self_test.broken + ', expected mismatch');
    if (typeof mod.checkRefs !== 'function') problems.push('forge-citations.cjs has no checkRefs (the refs command)');
    else {
      const got = ((mod.checkRefs(REFS_SAMPLE) || {}).findings || []).map((x) => x.kind + ':' + x.id).sort().join(',');
      base.self_test.refs = got;
      if (got !== REFS_EXPECTED) problems.push('the refs self-test found "' + (got || 'none') + '", expected "' + REFS_EXPECTED + '"');
    }
  } catch (e) {
    problems.push('forge-citations.cjs threw: ' + ((e && e.message) || e));
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: the OS cleans its temp */ } }
  }
  const lw = ledgerWarnings(root, mod);
  base.ledgers = lw.ledgers;
  if (lw.warn) base.warn = lw.warn;
  return Object.assign(finish(dev, base, problems), { ms: Date.now() - t0 });
}

/** toolSummaryLines(checks, line) -> printSummary's lines for ecc_path and citations (one each, only when present). */
function toolSummaryLines(c, line) {
  const out = [];
  const tag = (r) => r.overridden ? ' [OVERRIDDEN by ' + (r.override_by || 'owner') + ': ' + r.override_reason + ']' : '';
  const e = c && c.ecc_path;
  if (e) {
    const names = Object.keys(e.resolved || {});
    const sources = Array.from(new Set(names.map((n) => e.resolved[n].source))).join('/');
    const detail = e.applicable === false ? 'n/a — ' + e.reason
      : (e.reason || (names.join(' + ') + ' resolved (' + sources + ') · ' + e.ecc_skills + ' ecc skills'));
    out.push(line('ecc path', e.ok, detail + tag(e)));
  }
  const ci = c && c.citations;
  if (ci) {
    const st = ci.self_test || {};
    const detail = ci.reason || ((st.good === 'verified' ? 'real quote verified' : 'real quote ' + st.good) + ' · '
      + (st.broken === 'mismatch' ? 'cut quote rejected' : 'cut quote ' + st.broken) + (st.refs !== undefined ? ' · refs orphans found' : '')
      + ' · ' + (ci.ledgers || 0) + ' ledger(s)');
    out.push(line('citations', ci.ok, detail + (ci.warn ? ' · WARN ' + ci.warn : '') + tag(ci)));
  }
  return out;
}

module.exports = { ECC_REQUIRED_SKILLS, CITATION_GOOD_QUOTE, CITATION_CUT_QUOTE, eccPathCheck, citationsCheck, toolSummaryLines };
