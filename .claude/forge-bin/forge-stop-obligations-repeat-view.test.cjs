'use strict';
// forge-stop-obligations-repeat-view.test.cjs — the Stop hook's owner-repeat line is judged on the OWNER VIEW
// (forge-scribe.cjs ownerView + the scribe config), not on the raw stored repeat_of links (WP 3.8 made raw links
// unreliable: a stale hand-back link can create a false REPEAT, or join a genuine repeat to an already addressed chain
// where it disappears). Real hash-chained ledgers in temp projects, written through forge-scribe-store's own API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const OBL = require('./forge-stop-obligations.cjs');
const S = require('./forge-scribe-store.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stopobl-repeat-'));
const ts = '2026-10-24T00:00:00.000Z';
function ledgerProject(name, recs) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const p = S.paths(root);
  fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
  S.withLock(p, () => { recs.forEach((r, i) => S.appendChained(p.ledger, Object.assign({ seq: i + 1, ts }, r))); });
  return root;
}
const open = (n, quote, extra) => Object.assign({ op: 'open', rid: 'R-000' + n, class: 'new', pid: 'P-' + n, title: quote.slice(0, 60), quote }, extra || {});
const stop = (root, extra) => OBL.runStop({ stop_hook_active: false }, Object.assign({ projectRoot: root, env: {} }, extra || {}));

try {
  // A genuine repeat (R-0003 of R-0002) whose stored links ALSO name R-0001 — a stale hand-back link to a chain that already
  // has its HARD RULE. Raw links put all three in one addressed chain, so the genuine repeat was never shown.
  const hidden = ledgerProject('hidden', [
    open(1, 'Start parallel lanes for every multi part task and arm the lane watchdog automatically'),
    { op: 'repeat-rule', rid: 'R-0001', repeat_rule_ref: { type: 'standing_rule', ref: 'SR-1' } },
    open(2, 'Translate the dashboard settings page into Dutch, every label and every tooltip of the settings page'),
    open(3, 'Again: translate the dashboard settings page into Dutch, the settings page labels and tooltips are still English', { repeat_of: ['R-0001', 'R-0002'], repeat_count: 3 }),
  ]);
  // A stale stored link between two unrelated asks: raw links made it a REPEAT, the owner view does not confirm it.
  const stale = ledgerProject('stale', [
    open(4, 'Write the release notes for version ten of the installer'),
    open(5, 'Fix the flaky timeout in the gateway health check endpoint', { repeat_of: ['R-0004'], repeat_count: 2 }),
  ]);

  t('the ledgers are real: the store folds them and they hold the stored links', () => {
    const st = S.loadState(S.paths(hidden));
    assert.deepStrictEqual(st.items['R-0003'].repeat_of, ['R-0001', 'R-0002']);
    assert.ok(st.items['R-0001'].repeat_rule_ref);
    assert.deepStrictEqual(S.loadState(S.paths(stale)).items['R-0005'].repeat_of, ['R-0004']);
  });
  t('a genuine repeat hidden by a stale link to an addressed chain now appears (owner view)', () => {
    const r = stop(hidden);
    assert.ok(r.print && r.repeats === 1, JSON.stringify(r));
    assert.ok(/1 owner repeat\(s\) without a HARD RULE: R-0003 REPEAT x2 of R-0002/.test(r.text), r.text);
    assert.ok(!/R-0001/.test(r.text.split(' — ')[0]), 'the stale link is not shown');
  });
  t('COUNTERFACTUAL: on the raw stored links the same ledger shows nothing (the bug the owner view fixes)', () => {
    assert.strictEqual(OBL.repeatObligationLine(hidden, { scribeStore: S }), null);
  });
  t('a stale stored link creates no false REPEAT line (owner view)', () => {
    const r = stop(stale);
    assert.ok(!r.print && r.repeats === 0, JSON.stringify(r));
  });
  t('COUNTERFACTUAL: on the raw stored links the stale link IS a REPEAT line', () => {
    const raw = OBL.repeatObligationLine(stale, { scribeStore: S });
    assert.ok(raw && /R-0005 REPEAT x2 of R-0004/.test(raw.line), JSON.stringify(raw));
  });
  t('seams: injected scribe/classify are used; a throwing ownerView or a module without it falls back to the raw links, never a throw', () => {
    const SC = require('./forge-scribe.cjs'); const C = require('./forge-scribe-classify.cjs');
    assert.ok(/R-0003 REPEAT x2 of R-0002/.test(OBL.repeatObligationLine(hidden, { scribeStore: S, scribe: SC, classify: C }).line));
    const boom = { ownerView: () => { throw new Error('broken scribe'); } };
    assert.strictEqual(OBL.repeatObligationLine(hidden, { scribeStore: S, scribe: boom, classify: C }), null, 'raw view: nothing shown, no throw');
    assert.ok(/R-0005/.test(OBL.repeatObligationLine(stale, { scribe: {}, classify: C }).line), 'no ownerView export -> raw links');
    assert.ok(/R-0005/.test(OBL.repeatObligationLine(stale, { scribe: SC, classify: { loadConfig: () => { throw new Error('bad config'); } } }).line), 'config unreadable -> raw links');
  });
  t('the Stop hook CLI (spawned, CLAUDE_PROJECT_DIR = fixture) prints the owner-view line', () => {
    const { spawnSync } = require('child_process');
    const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: hidden }); delete env.FORGE_STOP_OBLIGATIONS;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-stop-obligations.cjs')], { input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }), env, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/R-0003 REPEAT x2 of R-0002/.test(r.stdout), r.stdout);
    const s = spawnSync(process.execPath, [path.join(__dirname, 'forge-stop-obligations.cjs')], { input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }), env: Object.assign({}, env, { CLAUDE_PROJECT_DIR: stale }), encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(s.status, 0, s.stderr);
    assert.ok(!/REPEAT/.test(s.stdout), 'no false REPEAT from the stale link: ' + s.stdout);
  });
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
