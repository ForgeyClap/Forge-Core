#!/usr/bin/env node
'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
/**
 * forge-default-skills.test.cjs — the one source of default skills and its loader (SD-T1).
 * Covers: the real source loads clean, every named skill ships in this repo, a non-shipped name is rejected,
 * the baseline cap, specialist and display-name mapping, file-less and unknown agents, and the loader never throws.
 * Throwaway roots only; never reads ~/.claude.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const DS = require('./forge-default-skills.cjs');

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 500) : '')); }
};
const repoRoot = path.resolve(__dirname, '..', '..');
const SRC_REL = path.join('.claude', 'config', 'orchestration', 'FORGE_DEFAULT_SKILLS.json');
const roots = [];
const tmp = (p) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(r); return r; };
const addSkill = (base, name) => { const d = path.join(base, '.claude', 'skills', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '# ' + name + '\n'); };
const writeSource = (base, data) => {
  const f = path.join(base, SRC_REL);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
};
const allNames = (d) => {
  const out = [d.conduct];
  for (const v of Object.values(d.role_baseline || {})) out.push(...v);
  for (const v of Object.values(d.specialist_extra || {})) out.push(...v);
  for (const v of Object.values(d.agent_domain || {})) out.push(...v);
  for (const v of Object.values(d.moments || {})) out.push(v.skill);
  return out;
};
const minimal = () => ({
  schema: 'forge-default-skills/v1',
  conduct: 'forge-conduct',
  role_baseline: { 'build-boss': ['forge-testing'] },
  specialists: {},
  specialist_extra: {},
  file_less: ['general-purpose'],
  global_agents: [],
  moments: {},
  limits: { max_baseline: 3, max_preload: 32, max_injection_chars: 10000, max_directive_chars: 300, conduct_max_lines: 80 },
});

try {
  console.log('\nA) the real source');
  const real = DS.loadDefaults(repoRoot);
  t('real source loads', real.ok === true && real.problems.length === 0, JSON.stringify(real.problems));
  const data = real.data || {};
  const missing = allNames(data).filter((n) => !fs.existsSync(path.join(repoRoot, '.claude', 'skills', String(n), 'SKILL.md')));
  t('every name ships', data.conduct && missing.length === 0, 'missing: ' + missing.join(', '));
  t('limits exported', DS.LIMITS && DS.LIMITS.max_baseline === 3 && DS.LIMITS.max_preload === 32 && DS.LIMITS.max_injection_chars === 10000 && DS.LIMITS.max_directive_chars === 300 && DS.LIMITS.conduct_max_lines === 80, JSON.stringify(DS.LIMITS));
  const dirOk = Object.values(data.moments || {}).every((m) => typeof m.directive === 'string' && m.directive.length > 0 && m.directive.length <= 300);
  t('moment directives at most 300 chars', Object.keys(data.moments || {}).length === 2 && dirOk);

  console.log('\nB) validation on throwaway roots');
  const bad = tmp('forge-ds-bad-');
  addSkill(bad, 'forge-conduct'); addSkill(bad, 'forge-testing');
  const badData = minimal(); badData.role_baseline['build-boss'] = ['forge-testing', 'test-driven-development'];
  writeSource(bad, badData);
  const rb = DS.loadDefaults(bad);
  t('non-shipped name rejected', rb.ok === false && rb.problems.some((p) => p.includes('test-driven-development')), JSON.stringify(rb.problems));

  const cap = tmp('forge-ds-cap-');
  ['forge-conduct', 'a1', 'a2', 'a3', 'a4'].forEach((n) => addSkill(cap, n));
  const capData = minimal(); capData.role_baseline['build-boss'] = ['a1', 'a2', 'a3', 'a4'];
  writeSource(cap, capData);
  const rc = DS.loadDefaults(cap);
  t('baseline cap', rc.ok === false && rc.problems.some((p) => p.includes('build-boss')), JSON.stringify(rc.problems));

  const longDir = tmp('forge-ds-dir-');
  ['forge-conduct', 'forge-testing', 'forge-prompt-coach'].forEach((n) => addSkill(longDir, n));
  const ldData = minimal(); ldData.moments = { vague_prompt: { skill: 'forge-prompt-coach', directive: 'x'.repeat(301) } };
  writeSource(longDir, ldData);
  const rl = DS.loadDefaults(longDir);
  t('long directive rejected', rl.ok === false && rl.problems.some((p) => p.includes('vague_prompt')), JSON.stringify(rl.problems));

  const dom = tmp('forge-ds-dom-');
  ['forge-conduct', 'forge-testing'].forEach((n) => addSkill(dom, n));
  const domData = minimal(); domData.agent_domain = { 'build-boss': ['forge-not-shipped'] };
  writeSource(dom, domData);
  const rd = DS.loadDefaults(dom);
  t('non-shipped domain name rejected', rd.ok === false && rd.problems.some((p) => p.includes('agent_domain.build-boss') && p.includes('forge-not-shipped')), JSON.stringify(rd.problems));
  const domKey = tmp('forge-ds-domkey-');
  ['forge-conduct', 'forge-testing'].forEach((n) => addSkill(domKey, n));
  const dkData = minimal(); dkData.agent_domain = { 'nobody-agent': ['forge-testing'] };
  writeSource(domKey, dkData);
  const rk = DS.loadDefaults(domKey);
  t('domain for an unknown agent rejected', rk.ok === false && rk.problems.some((p) => p.includes('agent_domain.nobody-agent')), JSON.stringify(rk.problems));
  const domCap = tmp('forge-ds-domcap-');
  const many = Array.from({ length: 32 }, (_, i) => 'd' + i);
  ['forge-conduct', 'forge-testing'].concat(many).forEach((n) => addSkill(domCap, n));
  const dcData = minimal(); dcData.agent_domain = { 'build-boss': many };
  writeSource(domCap, dcData);
  const rcap = DS.loadDefaults(domCap);
  t('preload total over max_preload rejected', rcap.ok === false && rcap.problems.some((p) => p.includes('build-boss') && p.includes('32')), JSON.stringify(rcap.problems));
  t('preload stays capped at max_preload', DS.preloadFor('build-boss', dcData).length === 32);

  console.log('\nC) mapping');
  t('specialist maps', DS.roleOf('electron-pro', data) === 'build-boss' && DS.preloadFor('payment-integration', data).includes('forge-security-review'));
  t('display names', DS.roleOf('Build Boss', data) === 'build-boss' && DS.roleOf('BUILD-BOSS', data) === 'build-boss');
  t('file-less', DS.roleOf('general-purpose', data) === 'file-less');
  t('unknown', DS.roleOf('some-ecc-agent', data) === null && JSON.stringify(DS.preloadFor('some-ecc-agent', data)) === '["forge-conduct"]');
  const pf = DS.preloadFor('build-boss', data);
  t('preload is conduct first, no duplicates', pf[0] === 'forge-conduct' && new Set(pf).size === pf.length && pf.length <= 32, JSON.stringify(pf));
  t('domainFor exported', typeof DS.domainFor === 'function' && JSON.stringify(DS.domainFor('build-boss', data)) === JSON.stringify(['forge-code-review', 'forge-worktrees']), JSON.stringify(DS.domainFor && DS.domainFor('build-boss', data)));
  const ep = DS.preloadFor('electron-pro', data);
  t('electron-pro gets the build-boss baseline but not its domain', DS.baselineFor('build-boss', data).every((s) => ep.includes(s)) && !ep.includes('forge-code-review') && !ep.includes('forge-worktrees') && DS.domainFor('electron-pro', data).length === 0, JSON.stringify(ep));
  t('ui-boss preload is exact', JSON.stringify(DS.preloadFor('ui-boss', data)) === JSON.stringify(['forge-conduct', 'forge-craft', 'forge-ui-polish', 'forge-website', 'forge-mobile', 'forge-verify']), JSON.stringify(DS.preloadFor('ui-boss', data)));
  const both = { conduct: 'forge-conduct', role_baseline: { 'test-boss': ['forge-testing', 'forge-verify'] }, agent_domain: { 'test-boss': ['forge-verify', 'forge-debug', 'forge-conduct'] } };
  t('a name in both baseline and domain appears once', JSON.stringify(DS.preloadFor('test-boss', both)) === JSON.stringify(['forge-conduct', 'forge-testing', 'forge-verify', 'forge-debug']), JSON.stringify(DS.preloadFor('test-boss', both)));
  t('baseline excludes conduct', !DS.baselineFor('build-boss', data).includes('forge-conduct') && DS.baselineFor('build-boss', data).length > 0);

  console.log('\nD) total');
  const nd = DS.loadDefaults('/no/such/dir');
  t('never throws', nd.ok === false && nd.data === null && nd.problems.length > 0);
  let threw = false;
  try { DS.roleOf(undefined, null); DS.baselineFor(42, undefined); DS.preloadFor(null, {}); DS.loadDefaults(undefined); DS.domainFor && DS.domainFor({}, 7); } catch (e) { threw = true; }
  t('helpers never throw on junk', threw === false);
  t('preload with no data still has conduct', JSON.stringify(DS.preloadFor('build-boss', null)) === '["forge-conduct"]');
} catch (e) {
  fail++; console.error('  FAIL unexpected throw :: ' + (e && e.stack || e));
} finally {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { console.error('cleanup failed: ' + r); } }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
