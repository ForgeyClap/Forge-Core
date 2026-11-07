#!/usr/bin/env node
'use strict';
/**
 * forge-skilllint.test.cjs —: forge-skilllint.cjs. Hermetic: every fixture lives in one os.mkdtemp folder
 * (removed at the end); the real project is only read (one smoke run).
 *   A. a clean skill has no error and no warning
 *   B. each fixture is flagged: uppercase name, 1,200-char description, missing description, --- on line 2,
 *      deep (nested) reference, backslash link, XML tag, reserved names, first person, no trigger, long body
 *   C. the listing budget: sum, disable-model-invocation kept out, over-budget warning, empty-in-listing
 *   D. CLI: report mode exit 0, --strict exit 1 on an error, --json parses
 *   E. mutations: a weakened rule makes the matching B assertion fail
 *   F. the real repo: runs read-only and returns a report
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./forge-skilllint.cjs');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skilllint-')));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + String(extra).slice(0, 600) : '')); } };
const GOOD = 'Reviews pull-request diffs for correctness and security. Use when the user asks for a code review.';
let n = 0;
function mkRoot() { const r = path.join(TMP, 'r' + (++n)); fs.mkdirSync(path.join(r, '.claude', 'skills'), { recursive: true }); return r; }
function skill(root, id, front, body, extra) {
  const d = path.join(root, '.claude', 'skills', ...id.split('/'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), (front === null ? '' : '---\n' + front + '\n---\n') + (body || '# Skill\n\nBody.\n'));
  for (const [f, c] of Object.entries(extra || {})) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
}
const rules = (rep, id) => rep.findings.filter((f) => f.skill === id).map((f) => f.level + ':' + f.rule);
const has = (rep, id, rule, level) => rep.findings.some((f) => f.skill === id && f.rule === rule && (!level || f.level === level));

function fixtureRoot() {
  const r = mkRoot();
  skill(r, 'good-skill', 'name: good-skill\ndescription: ' + GOOD, '# Good\n\nSee [the guide](references/guide.md).\n', { 'references/guide.md': '# Guide\n\nPlain text.\n' });
  skill(r, 'upper', 'name: Code-Review\ndescription: ' + GOOD);
  skill(r, 'long-desc', 'name: long-desc\ndescription: "' + 'Reviews code. Use when asked. '.repeat(40).slice(0, 1200) + '"');
  skill(r, 'no-desc', 'name: no-desc');
  fs.mkdirSync(path.join(r, '.claude', 'skills', 'line-two'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude', 'skills', 'line-two', 'SKILL.md'), '\n---\nname: line-two\ndescription: ' + GOOD + '\n---\nbody\n');
  skill(r, 'deep-ref', 'name: deep-ref\ndescription: ' + GOOD, 'See [advanced](advanced.md).\n', { 'advanced.md': 'See [details](details.md).\n', 'details.md': 'The real information.\n' });
  skill(r, 'slash', 'name: slash\ndescription: ' + GOOD, 'See [ref](references\\guide.md).\n', { 'references/guide.md': 'x\n' });
  skill(r, 'xml', 'name: xml\ndescription: Formats <b>bold</b> text. Use when formatting.');
  skill(r, 'claude-helper', 'name: claude-helper\ndescription: ' + GOOD);
  skill(r, 'synced', 'name: synced\ndescription: ' + GOOD);
  skill(r, 'first-person', 'name: first-person\ndescription: I can review your code. Use when reviewing.');
  skill(r, 'no-trigger', 'name: no-trigger\ndescription: Playbook for contract-first APIs and versioning.');
  skill(r, 'long-body', 'name: long-body\ndescription: ' + GOOD, 'line\n'.repeat(520));
  skill(r, 'manual', 'name: manual\ndescription: Playbook without a trigger.\ndisable-model-invocation: true');
  skill(r, 'folded', 'name: folded\ndescription: >\n  Reviews diffs carefully.\n  Use when asked for a review.');
  skill(r, 'group/nested-one', 'name: nested-one\ndescription: ' + GOOD);
  return r;
}

try {
  const root = fixtureRoot();
  const rep = L.lintSkills(root, { env: {} });

  // A
  t('A1 a clean skill has no finding at all', rules(rep, 'good-skill').length === 0, rules(rep, 'good-skill'));
  t('A2 a folded block description is read whole and is clean', rules(rep, 'folded').length === 0, rules(rep, 'folded'));
  t('A3 a nested skill is linted and found', rep.skills === 16 && rules(rep, 'group/nested-one').length === 0, rep.skills);

  // B
  t('B1 uppercase name -> error name_format', has(rep, 'upper', 'name_format', 'error'));
  t('B2 1,200-char description -> error description_too_long', has(rep, 'long-desc', 'description_too_long', 'error'), rules(rep, 'long-desc'));
  t('B3 missing description -> error description_missing', has(rep, 'no-desc', 'description_missing', 'error'));
  t('B4 --- on line 2 -> error frontmatter naming line 2', rep.findings.some((f) => f.skill === 'line-two' && f.rule === 'frontmatter' && f.level === 'error' && /line 2/.test(f.message)));
  t('B5 SKILL -> advanced -> details -> warn reference_nested', has(rep, 'deep-ref', 'reference_nested', 'warn') && rep.findings.some((f) => /advanced\.md -> details\.md/.test(f.message)));
  t('B6 a direct one-level reference is NOT nested', !has(rep, 'good-skill', 'reference_nested'));
  t('B7 a backslash link -> error reference_backslash', has(rep, 'slash', 'reference_backslash', 'error'));
  t('B8 an XML tag in the description -> error description_xml', has(rep, 'xml', 'description_xml', 'error'));
  t('B9 "claude" in the name -> warn name_reserved_word (Claude Code still loads it)', has(rep, 'claude-helper', 'name_reserved_word', 'warn') && !has(rep, 'claude-helper', 'name_format'));
  t('B10 the folder name synced -> error name_refused', has(rep, 'synced', 'name_refused', 'error'));
  t('B11 "I can ..." -> warn description_person', has(rep, 'first-person', 'description_person', 'warn'));
  t('B12 no trigger phrase -> warn description_trigger', has(rep, 'no-trigger', 'description_trigger', 'warn'));
  t('B13 a 520-line body -> warn body_long (never an error)', has(rep, 'long-body', 'body_long', 'warn') && !has(rep, 'long-body', 'body_long', 'error'));
  t('B14 a manual-only skill is not asked for a trigger phrase', !has(rep, 'manual', 'description_trigger'));
  t('B15 a Dutch trigger phrase counts', (() => { const r = mkRoot(); skill(r, 'nl', 'name: nl\ndescription: Controleert diffs. Gebruik bij elke review.'); return !has(L.lintSkills(r, { env: {} }), 'nl', 'description_trigger'); })());
  t('B16 a Windows command example with backslashes is not a reference', (() => { const r = mkRoot(); skill(r, 'win', 'name: win\ndescription: ' + GOOD, 'Run `.\\tools\\run.ps1` in PowerShell.\n'); return !has(L.lintSkills(r, { env: {} }), 'win', 'reference_backslash'); })());

  // C
  const lst = rep.listing;
  t('C1 disable-model-invocation keeps a skill out of the listing', lst.not_listed_disable_model_invocation.includes('manual'));
  t('C2 nested skills are not counted in the listing total', lst.nested_not_counted === 1);
  const expected = (() => { let s = 0; for (const f of fs.readdirSync(path.join(root, '.claude', 'skills'))) { if (['group', 'line-two', 'manual', 'synced'].includes(f)) continue; const p = L.parseFrontmatter(fs.readFileSync(path.join(root, '.claude', 'skills', f, 'SKILL.md'), 'utf8')); if (!p.ok) continue; const nm = (p.data.name && p.data.name.value) || f; const d = (p.data.description && p.data.description.value) || ''; s += nm.length + Math.min(d.length, 1536); } return s; })();
  t('C3 the listing total is name + description per listed skill', lst.total_chars === expected, lst.total_chars + ' vs ' + expected);
  t('C4 the budget defaults to the documented estimate (8,000 chars at 200K)', lst.budget_chars === 8000 && !lst.over);
  const over = L.lintSkills(root, { env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '100' } });
  t('C5 SLASH_COMMAND_TOOL_CHAR_BUDGET wins and an over-budget listing warns', over.listing.budget_chars === 100 && over.listing.over && over.findings.some((f) => f.rule === 'listing_budget' && f.level === 'warn'));
  t('C6 a skill with no description is listed as empty in the listing', lst.empty_in_listing.includes('no-desc') && rep.findings.some((f) => f.rule === 'listing_empty'));
  const off = mkRoot();
  skill(off, 'quiet', 'name: quiet\ndescription: ' + GOOD);
  fs.writeFileSync(path.join(off, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { quiet: 'name-only' } }));
  const offRep = L.lintSkills(off, { env: {} });
  t('C7 skillOverrides name-only counts only the name', offRep.listing.total_chars === 5 && offRep.listing.name_only_or_off[0] === 'quiet (name-only)');

  // D
  const outs = [];
  const io = { out: (s) => outs.push(s) };
  t('D1 report mode exits 0 even with errors', L.main(['--root', root], io) === 0 && /error/.test(outs[0]));
  t('D2 --strict exits 1 on an error-level finding', L.main(['--root', root, '--strict'], io) === 1);
  const clean = mkRoot();
  skill(clean, 'good-skill', 'name: good-skill\ndescription: ' + GOOD);
  t('D3 --strict exits 0 on a clean tree', L.main(['--root', clean, '--strict'], io) === 0);
  outs.length = 0;
  L.main(['--root', root, '--json'], io);
  let parsed = null; try { parsed = JSON.parse(outs[0]); } catch { parsed = null; }
  t('D4 --json prints a parseable report with counts', parsed && parsed.counts && parsed.counts.error > 0 && Array.isArray(parsed.findings));
  t('D5 a missing root exits 2', L.main(['--root', path.join(TMP, 'nope')], io) === 2);

  // E — mutations: copy the tool, weaken one rule, prove the matching assertion would fail.
  const SRC = fs.readFileSync(path.join(__dirname, 'forge-skilllint.cjs'), 'utf8');
  const mutant = (label, from, to) => {
    if (!SRC.includes(from)) { t('E mutation anchor present: ' + label, false, from); return null; }
    const f = path.join(TMP, 'mutant-' + label + '.cjs');
    fs.writeFileSync(f, SRC.replace(from, to));
    return require(f).lintSkills(root, { env: {} });
  };
  const m1 = mutant('desc-max', 'const DESCRIPTION_MAX = 1024;', 'const DESCRIPTION_MAX = 4096;');
  t('E1 MUTANT description max 4096: B2 would fail', m1 && !has(m1, 'long-desc', 'description_too_long'));
  const m2 = mutant('name-format', "if (!/^[a-z0-9-]+$/.test(name))", 'if (false)');
  t('E2 MUTANT name format off: B1 would fail', m2 && !has(m2, 'upper', 'name_format'));
  const m3 = mutant('nested', "push('warn', 'reference_nested'", "void ('warn', 'reference_nested'");
  t('E3 MUTANT nested reference off: B5 would fail', m3 && !has(m3, 'deep-ref', 'reference_nested'));
  const m4 = mutant('line1', "if (lines[0] !== '---') {", "if (false) {");
  t('E4 MUTANT line-1 rule off: B4 would fail', m4 && !m4.findings.some((f) => f.skill === 'line-two' && f.rule === 'frontmatter' && /line 2/.test(f.message)));

  // G — WP A10: --with-global counts the global and plugin listing, read-only, in a fake home folder.
  const fakeHome = path.join(TMP, 'home');
  const gdir = (id, front) => { const d = path.join(fakeHome, '.claude', 'skills', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), '---\n' + front + '\n---\nbody\n'); };
  gdir('glob-a', 'name: glob-a\ndescription: Does a thing. Use when asked.');
  gdir('glob-manual', 'name: glob-manual\ndescription: Hidden.\ndisable-model-invocation: true');
  const pInstall = path.join(TMP, 'plug-install');
  fs.mkdirSync(path.join(pInstall, 'skills', 'ps1'), { recursive: true });
  fs.writeFileSync(path.join(pInstall, 'skills', 'ps1', 'SKILL.md'), '---\nname: ps1\ndescription: Plugin skill. Use when asked.\n---\nbody\n');
  fs.mkdirSync(path.join(fakeHome, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'myplug@market': [{ installPath: pInstall }] } }));
  const gRoot = mkRoot();
  skill(gRoot, 'good-skill', 'name: good-skill\ndescription: ' + GOOD);
  const gRep = L.lintSkills(gRoot, { env: {}, withGlobal: true, home: fakeHome });
  const gA = 'glob-a'.length + 'Does a thing. Use when asked.'.length;
  const gP = 'myplug'.length + 1 + 'ps1'.length + 'Plugin skill. Use when asked.'.length;
  t('G1 global part = name + description of listed global skills, manual-only excluded', gRep.listing.global.entries === 1 && gRep.listing.global.total_chars === gA && gRep.listing.global.not_listed_disable_model_invocation === 1, JSON.stringify(gRep.listing.global));
  t('G2 plugin part counts plugin:skill from installed_plugins.json', gRep.listing.plugin.entries === 1 && gRep.listing.plugin.plugins === 1 && gRep.listing.plugin.total_chars === gP, JSON.stringify(gRep.listing.plugin));
  t('G3 total = project + global + plugin with percentages of the budget', gRep.listing.total_all_chars === gRep.listing.total_chars + gA + gP && gRep.listing.total_all_pct === Math.round((gRep.listing.total_all_chars / 8000) * 1000) / 10 && typeof gRep.listing.global.pct === 'number');
  t('G4 the total over budget warns (tiny budget)', (() => { const x = L.lintSkills(gRoot, { env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '50' }, withGlobal: true, home: fakeHome }); return x.listing.total_all_over && x.findings.some((f) => f.rule === 'listing_total' && f.level === 'warn'); })());
  t('G5 default mode adds exactly one listing_total info line and no global key', rep.findings.filter((f) => f.rule === 'listing_total').length === 1 && rep.listing.global === undefined && /project only/.test(rep.findings.find((f) => f.rule === 'listing_total').message));
  t('G6 a missing home or plugin file counts zero and does not throw', (() => { const x = L.lintSkills(gRoot, { env: {}, withGlobal: true, home: path.join(TMP, 'nohome') }); return x.listing.global.total_chars === 0 && x.listing.plugin.total_chars === 0; })());
  const gOuts = [];
  L.main(['--root', gRoot, '--with-global', '--home', fakeHome], { out: (s) => gOuts.push(s) });
  // G7 (A10 rework): assert text that ONLY the --with-global line has (the summed total with its percentage and the
  // upper-bound note) and that the project-only text is absent; then prove the default CLI output lacks that pattern.
  const TOTAL_RE = /listing total: project \d+ chars \([\d.]+%, \d+ skills\) \+ global \d+ \([\d.]+%, \d+ skills\) \+ plugin \d+ \([\d.]+%, \d+ skills in \d+ plugin\(s\)\) = \d+ chars = [\d.]+% of the ~\d+-char budget \(upper bound/;
  const dOuts = [];
  L.main(['--root', gRoot, '--home', fakeHome], { out: (s) => dOuts.push(s) });
  t('G7 CLI --with-global prints the summed total + percentage + "(upper bound" and not the project-only line', TOTAL_RE.test(gOuts[0]) && !/project only/.test(gOuts[0]) && !/run with --with-global/.test(gOuts[0]), gOuts[0]);
  t('G7b CLI default (no --with-global) has the project-only line and not the summed total', /listing total \(project only\)/.test(dOuts[0]) && !TOTAL_RE.test(dOuts[0]) && !/upper bound/.test(dOuts[0]), dOuts[0]);
  t('G7c the --with-global line says "(upper bound" even under budget', !gRep.listing.total_all_over && /\(upper bound/.test(gRep.findings.find((f) => f.rule === 'listing_total').message));
  t('G8 the fake global and plugin folders were not modified (read-only)', fs.readFileSync(path.join(fakeHome, '.claude', 'skills', 'glob-a', 'SKILL.md'), 'utf8').endsWith('body\n'));
  t('G9 mutation anchor present', SRC.includes('listing.total_all_chars = listing.total_chars + g.total_chars + pl.total_chars;'));
  const m5src = SRC.replace('listing.total_all_chars = listing.total_chars + g.total_chars + pl.total_chars;', 'listing.total_all_chars = listing.total_chars;');
  fs.writeFileSync(path.join(TMP, 'mutant-global2.cjs'), m5src);
  const gm = require(path.join(TMP, 'mutant-global2.cjs')).lintSkills(gRoot, { env: {}, withGlobal: true, home: fakeHome });
  t('G10 MUTANT total ignores global: G3 assertion fails on it', gm.listing.total_all_chars !== gm.listing.total_chars + gA + gP);

  // F
  const realRoot = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(realRoot, '.claude', 'skills'))) {
    const real = L.lintSkills(realRoot);
    t('F1 the real repo lints without throwing and finds skills', real.skills > 0 && real.counts && typeof real.listing.total_chars === 'number', real.skills);
    // H: the vendored humanizer skill sits on upstream blader/humanizer v3.1.0 (commit 225a6f3) with
    // its MIT LICENSE, the upstream body byte-for-byte (LF-normalised sha256), the short local description that the
    // listing budget is sized for, and no hidden unicode or dynamic-context lines. Read-only on the real tree.
    const hDir = path.join(realRoot, '.claude', 'skills', 'humanizer');
    if (fs.existsSync(path.join(hDir, 'SKILL.md'))) {
      const crypto = require('crypto');
      const lf = (s) => s.replace(/\r\n/g, '\n');
      const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
      const hText = lf(fs.readFileSync(path.join(hDir, 'SKILL.md'), 'utf8'));
      const fm = hText.match(/^---\n[\s\S]*?\n---\n/);
      const afterFm = fm ? hText.slice(fm[0].length) : '';
      const prov = afterFm.match(/^\n?<!--[\s\S]*?-->\n/);
      const body = prov ? afterFm.slice(prov[0].length) : afterFm;
      t('H1 humanizer provenance: Source blader/humanizer + Pinned commit = v3.1.0 (225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8)',
        !!prov && /^\s*Source: https:\/\/github\.com\/blader\/humanizer\s*$/m.test(prov[0]) && /^\s*Pinned commit: 225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8\b/m.test(prov[0]), prov && prov[0]);
      t('H2 humanizer ships the upstream MIT LICENSE unchanged (sha256 4ac48102...)',
        fs.existsSync(path.join(hDir, 'LICENSE')) && sha(lf(fs.readFileSync(path.join(hDir, 'LICENSE'), 'utf8'))) === '4ac4810254ab36d45419141aeb8e69bf50652cfafe5b2dab947d06d44e5cbf96');
      t('H3 humanizer body is the v3.1.0 upstream body byte-for-byte (sha256 86588ff3...)', sha(body) === '86588ff3105fb588205cfecafb732111febc4eba51861e3ffda84d414311e9a0', sha(body));
      const hFindings = real.findings.filter((f) => f.skill === 'humanizer').map((f) => f.level + ':' + f.rule);
      t('H4 humanizer is under the 500-line body limit (no body_long finding)', hText.split('\n').length < 500 && !hFindings.includes('warn:body_long'), hText.split('\n').length + ' ' + hFindings.join(','));
      // 2026-11-05 (skills-audit batch B): the owner's own phrase "no ai stop" (and its Dutch twin) added to the
      // short listing description so the skill fires on it; still one short line, the body stays byte-identical (H3).
      t('H5 humanizer keeps the short listing-budget description', /^description: Removes AI-writing tells from text \(no ai stop, klinkt als AI\)\. Use when editing text to sound human\.$/m.test(fm ? fm[0] : ''), fm && fm[0]);
      t('H6 humanizer has no hidden/bidi/zero-width/control characters', !/[​-‏‪-‮⁠-⁤⁦-⁩﻿­᠎͏\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(hText));
      t('H7 humanizer has no dynamic-context (!`cmd`) lines and does not pre-approve AskUserQuestion or Bash',
        !/^\s*!`|!`[^`]*`/m.test(hText) && !/AskUserQuestion|^\s*-\s*Bash\b/m.test(fm ? fm[0] : ''));
    } else t('H skipped: no humanizer skill in this tree', true);
  } else t('F1 skipped: no .claude/skills next to this tool', true);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.error('  note: could not remove ' + TMP + ' (' + e.message + ')'); }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
