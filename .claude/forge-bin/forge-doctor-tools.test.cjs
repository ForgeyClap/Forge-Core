#!/usr/bin/env node
'use strict';
/**
 * forge-doctor-tools.test.cjs — W2-WIRE. The doctor guards two zero-dependency research tools:
 *   ecc_path  — forge-ecc-path.cjs: red when ECC is installed (<home>/.claude/skills/ecc) but resolveSkill('skill-stocktake')
 *               or resolveSkill('skill-scout') returns null, or listSkills() finds no ecc skill; a visible skip when
 *               ECC is absent (fresh machine).
 *   citations — forge-citations.cjs: a real quote verifies and a quote with a word cut mid-way does not; a stored
 *               mismatch in any .claude/forge-runs/<run>/citations.jsonl is a warning, never red.
 * Fixtures live in one os.tmpdir() folder removed at the end. Broken tools are injected through opts.loadTool, so
 * no test edits a real tool. Harness: this project's tFn + trailing "N passed, M failed" tally (runTests reads it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let T = null, loadError = null;
try { T = require('./doctor/checks-tools.cjs'); } catch (e) { loadError = e; }
const D = require('./forge-doctor.cjs');

let pass = 0, fail = 0;
const tFn = (name, fn) => { try { if (!T) throw new Error('doctor/checks-tools.cjs does not load: ' + (loadError && loadError.message)); fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + (e && e.message || e)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-tools-'));
let seq = 0;
const wf = (base, rel, body) => { const p = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
function project(opts) {
  const root = path.join(TMP, 'p' + (++seq));
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  if (!opts || opts.dev !== false) wf(root, '.claude/config/forge-dev-tree.json', '{"dev_tree": true}\n');
  return root;
}
/** userHome(ecc) — a throwaway user home; ecc = the skill names under .claude/skills/ecc (null = ECC not installed). */
function userHome(ecc) {
  const h = path.join(TMP, 'h' + (++seq));
  fs.mkdirSync(path.join(h, '.claude', 'skills'), { recursive: true });
  for (const n of ecc || []) wf(h, '.claude/skills/ecc/' + n + '/SKILL.md', '---\nname: ' + n + '\ndescription: x\n---\n');
  if (ecc && !ecc.length) fs.mkdirSync(path.join(h, '.claude', 'skills', 'ecc'), { recursive: true });
  return h;
}
const realEcc = require('./forge-ecc-path.cjs');
const realCit = require('./forge-citations.cjs');
const loader = (over) => (name) => {
  if (over && Object.prototype.hasOwnProperty.call(over, name)) { const v = over[name]; if (v instanceof Error) throw v; return v; }
  return name === 'forge-ecc-path.cjs' ? realEcc : realCit;
};

console.log('forge-doctor tool checks (W2-WIRE)');

// ------------------------------------------------------------------ ecc_path
tFn('ecc_path: ECC installed with both skills resolves them from the ecc root and is green', () => {
  const r = T.eccPathCheck(project(), { home: userHome(['skill-stocktake', 'skill-scout', 'council']) });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.applicable, true);
  assert.strictEqual(r.ecc_skills, 3);
  assert.strictEqual(r.resolved['skill-stocktake'].source, 'ecc');
  assert.strictEqual(r.resolved['skill-scout'].source, 'ecc');
});
tFn('ecc_path RED: ECC installed but skill-scout missing names the skill and is red in the dev tree', () => {
  const r = T.eccPathCheck(project(), { home: userHome(['skill-stocktake']) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /resolveSkill\('skill-scout'\) returned null/);
});
tFn('ecc_path RED: an empty ecc folder (0 ecc skills) is red and says listSkills found none', () => {
  const r = T.eccPathCheck(project(), { home: userHome([]) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /listSkills\(\) found 0 ecc skills/);
});
tFn('ecc_path RED (mutant): a resolver whose resolveSkill always returns null is caught although the files exist', () => {
  const broken = Object.assign({}, realEcc, { resolveSkill: () => null });
  const r = T.eccPathCheck(project(), { home: userHome(['skill-stocktake', 'skill-scout']), loadTool: loader({ 'forge-ecc-path.cjs': broken }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /skill-stocktake/);
});
tFn('ecc_path RED (mutant): a resolver whose listSkills drops the ecc root is caught', () => {
  const broken = Object.assign({}, realEcc, { listSkills: (o) => realEcc.listSkills(o).filter((s) => s.source !== 'ecc') });
  const r = T.eccPathCheck(project(), { home: userHome(['skill-stocktake', 'skill-scout']), loadTool: loader({ 'forge-ecc-path.cjs': broken }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /0 ecc skills/);
});
tFn('ecc_path RED: a resolver that does not load is red with the load error', () => {
  const r = T.eccPathCheck(project(), { home: userHome(['skill-stocktake', 'skill-scout']), loadTool: loader({ 'forge-ecc-path.cjs': new Error('Cannot find module') }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /forge-ecc-path\.cjs does not load: Cannot find module/);
});
tFn('ecc_path: ECC absent is a visible skip (applicable false, ok true, reason says so)', () => {
  const r = T.eccPathCheck(project(), { home: userHome(null) });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.applicable, false);
  assert.match(r.reason, /ECC not installed/);
});
tFn('ecc_path: outside the development tree a broken resolver is labelled, not red', () => {
  const r = T.eccPathCheck(project({ dev: false }), { home: userHome(['skill-stocktake']) });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.enforced, false);
  assert.match(r.reason, /not enforced outside the development tree/);
});
tFn('ecc_path: a fixture root with no explicit home never reads the real machine', () => {
  const r = T.eccPathCheck(project(), {});
  assert.strictEqual(r.applicable, false); assert.match(r.reason, /not this doctor's own project root/);
});

// ------------------------------------------------------------------ citations
tFn('citations: the real module verifies the real quote and rejects the cut quote (green)', () => {
  const r = T.citationsCheck(project(), {});
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.self_test.good, 'verified');
  assert.strictEqual(r.self_test.broken, 'mismatch');
});
tFn('citations RED (mutant): a matcher that accepts any substring (no word boundary) lets the cut quote pass', () => {
  const loose = Object.assign({}, realCit, { evaluateClaim: (rec, o) => {
    const text = fs.readFileSync(path.resolve(o.root, rec.source_path), 'utf8').toLowerCase();
    return { claim_id: rec.claim_id, status: text.includes(rec.quote.toLowerCase()) ? 'verified' : 'mismatch', reason: 'x' };
  } });
  const r = T.citationsCheck(project(), { loadTool: loader({ 'forge-citations.cjs': loose }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cut quote .* was verified/);
});
tFn('citations RED (mutant): a matcher that rejects everything fails the real quote', () => {
  const none = Object.assign({}, realCit, { evaluateClaim: (rec) => ({ claim_id: rec.claim_id, status: 'mismatch', reason: 'quote_not_found' }) });
  const r = T.citationsCheck(project(), { loadTool: loader({ 'forge-citations.cjs': none }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /real quote .* was mismatch/);
});
tFn('citations RED: a module that does not load is red', () => {
  const r = T.citationsCheck(project(), { loadTool: loader({ 'forge-citations.cjs': new Error('SyntaxError: boom') }) });
  assert.strictEqual(r.ok, false); assert.match(r.reason, /forge-citations\.cjs does not load: SyntaxError: boom/);
});
tFn('citations: a stored mismatch in a run ledger is a WARNING (ok stays true) that names run and claim', () => {
  const root = project();
  wf(root, '.claude/forge-runs/run-a/citations.jsonl', JSON.stringify({ claim_id: 'c1', status: 'verified' }) + '\n' + JSON.stringify({ claim_id: 'c2', status: 'mismatch', reason: 'quote_not_found' }) + '\n');
  wf(root, '.claude/forge-runs/run-b/citations.jsonl', '{not json}\n');
  const r = T.citationsCheck(root, {});
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.ledgers, 2);
  assert.match(r.warn, /run-a: c2/);
  assert.match(r.warn, /run-b: unreadable/);
});
tFn('citations: the self-test cleans its own temp folder', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-doctor-cit-')).length;
  T.citationsCheck(project(), {});
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-doctor-cit-')).length;
  assert.strictEqual(after, before);
});

// ------------------------------------------------------------------ wiring + summary
tFn('citations: the refs self-test finds the planted undefined marker, unused reference and malformed DOI (green)', () => {
  const r = T.citationsCheck(project(), {});
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.self_test.refs, 'malformed_doi:10.12/x,undefined_marker:3,unused_reference:2');
});
tFn('citations RED (mutant): a refs check that finds nothing is red', () => {
  const blind = Object.assign({}, realCit, { checkRefs: () => ({ references: 0, markers: 0, findings: [] }) });
  const r = T.citationsCheck(project(), { loadTool: loader({ 'forge-citations.cjs': blind }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /refs self-test found "none"/);
});
tFn('citations RED (mutant): a tool without checkRefs (the refs command) is red', () => {
  const old = Object.assign({}, realCit);
  delete old.checkRefs;
  const r = T.citationsCheck(project(), { loadTool: loader({ 'forge-citations.cjs': old }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no checkRefs/);
});
tFn('summary: the citations line names the refs self-test only when it ran', () => {
  const line = (label, ok, detail) => (ok ? '✓ ' : '✗ ') + label + '  ' + detail;
  const out = T.toolSummaryLines({ citations: { ok: true, applicable: true, self_test: { good: 'verified', broken: 'mismatch', refs: 'x' }, ledgers: 0 } }, line).join('\n');
  assert.match(out, /cut quote rejected · refs orphans found · 0 ledger\(s\)/);
});
tFn('wired: ecc_path and citations are ENFORCED doctor checks, right after skill_adapters, and re-exported', () => {
  const order = D.DOCTOR_CHECK_ORDER.checks;
  assert.deepStrictEqual(order.slice(order.indexOf('skill_adapters'), order.indexOf('skill_adapters') + 3), ['skill_adapters', 'ecc_path', 'citations']);
  assert.strictEqual(D.eccPathCheck, T.eccPathCheck);
  assert.strictEqual(D.citationsCheck, T.citationsCheck);
  assert.ok(D.DOCTOR_MODULES.includes('doctor/checks-tools.cjs'));
});
tFn('summary: one line each — a green ecc path line, a skip line, a red citations line, and a printed warning', () => {
  const line = (label, ok, detail) => (ok ? '  ✓ ' : '  ✗ ') + label.padEnd(16) + detail;
  const lines = (checks) => T.toolSummaryLines(checks, line).join('\n');
  const green = lines({ ecc_path: { ok: true, applicable: true, ecc_skills: 35, resolved: { 'skill-stocktake': { source: 'ecc' }, 'skill-scout': { source: 'ecc' } }, reason: '' } });
  assert.match(green, /✓ ecc path\s+skill-stocktake \+ skill-scout resolved \(ecc\) · 35 ecc skills/);
  assert.strictEqual(green.split('\n').length, 1, 'no citations line when the check is absent');
  const skip = lines({ ecc_path: { ok: true, applicable: false, reason: 'skipped: ECC not installed' } });
  assert.match(skip, /✓ ecc path\s+n\/a — skipped: ECC not installed/);
  const red = lines({ citations: { ok: false, applicable: true, reason: 'cut quote was verified' } });
  assert.match(red, /✗ citations\s+cut quote was verified/);
  const warn = lines({ citations: { ok: true, applicable: true, self_test: { good: 'verified', broken: 'mismatch' }, ledgers: 1, warn: '1 stored mismatch: run-a: c2' } });
  assert.match(warn, /✓ citations\s+real quote verified · cut quote rejected · 1 ledger\(s\) · WARN 1 stored mismatch: run-a: c2/);
  const over = lines({ citations: { ok: true, applicable: true, overridden: true, override_by: 'owner', override_reason: 'r', reason: 'x' } });
  assert.match(over, /\[OVERRIDDEN by owner: r\]/);
});
tFn('wired: printSummary prints both lines through toolSummaryLines, right after the skill adapters line', () => {
  const src = fs.readFileSync(path.join(__dirname, 'doctor', 'report.cjs'), 'utf8');
  assert.match(src, /require\('\.\/checks-tools\.cjs'\)/);
  const a = src.indexOf("line('skill adapters'"), b = src.indexOf('toolSummaryLines(c, line)');
  assert.ok(a > 0 && b > a, 'toolSummaryLines(c, line) must follow the skill adapters line');
});
tFn('REAL machine (read-only): both checks run on this project and pass', () => {
  const root = path.resolve(__dirname, '..', '..');
  const e = T.eccPathCheck(root);
  assert.strictEqual(e.ok, true, e.reason);
  const c = T.citationsCheck(root);
  assert.strictEqual(c.ok, true, c.reason);
  console.log('    info ecc_path: ' + (e.applicable ? e.ecc_skills + ' ecc skills' : e.reason) + ' · citations: ' + c.ledgers + ' ledger(s)' + (c.warn ? ' · ' + c.warn : ''));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
