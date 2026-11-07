#!/usr/bin/env node
'use strict';
// forge-scout.test.cjs — real tests for the Scout term-generator + persistent vetting ledger (PIECE P5,
// 2026-07-22). Every fixture-based section writes ONLY under a fresh os.tmpdir() directory (freshDir()) via
// opts.vettingPath / the FORGE_SCOUT_VETTING_PATH env var — this file NEVER writes to this repo's real
// config/orchestration/FORGE_SCOUT_VETTING.json. Hermetic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const scout = require('./forge-scout.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function freshLedgerPath(prefix) { return path.join(freshDir(prefix), 'FORGE_SCOUT_VETTING.json'); }
const NOWHERE = path.join(os.tmpdir(), 'forge-scout-does-not-exist-' + Date.now(), 'FORGE_SCOUT_VETTING.json');

const CLI = path.join(__dirname, 'forge-scout.cjs');
function runCLI(argv, env) {
  return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env });
}

console.log('forge-scout tests (term-generator + vetting ledger — PIECE P5)');

// ---------------------------------------------------------------------------
// 1) terms() — domain-tailored, NOT generic; distinct across domains
// ---------------------------------------------------------------------------
console.log('\n1) terms() is domain-tailored and distinct');

t('slides domain returns the exact tailored examples from the doctrine', () => {
  const r = scout.terms({ domain: 'slides' }, {});
  assert.strictEqual(r.domain, 'slides');
  assert.ok(r.terms.includes('claude powerpoint skill'));
  assert.ok(r.terms.includes('claude slide generator skill'));
  assert.ok(r.terms.includes('I stopped using PowerPoint claude code skill'));
});

t('astro domain returns astro-tailored terms', () => {
  const r = scout.terms({ domain: 'astro' }, {});
  assert.ok(r.terms.includes('claude astro skill'));
  assert.ok(r.terms.includes('bulk website generator claude'));
});

t('slides and astro produce DISTINCT term sets (no accidental generic overlap-only list)', () => {
  const slides = scout.terms({ domain: 'slides' }, {}).terms;
  const astro = scout.terms({ domain: 'astro' }, {}).terms;
  assert.notDeepStrictEqual(slides.slice().sort(), astro.slice().sort());
  // no shared terms at all between two curated, unrelated domains
  const overlap = slides.filter((x) => astro.includes(x));
  assert.strictEqual(overlap.length, 0, 'slides and astro terms should not overlap: ' + JSON.stringify(overlap));
});

t('domain is case-insensitive (SEED_TEMPLATES lookup lowercases)', () => {
  const r = scout.terms({ domain: 'SLIDES' }, {});
  assert.ok(r.terms.includes('claude powerpoint skill'));
});

t('an uncurated domain still gets a domain-TAILORED fallback (bakes the domain word in, never a bare generic phrase)', () => {
  const r = scout.terms({ domain: 'beekeeping' }, {});
  assert.ok(r.terms.some((x) => x.includes('beekeeping')), 'fallback terms must mention the actual domain: ' + JSON.stringify(r.terms));
  assert.ok(!r.terms.includes('claude skill'), 'must never degrade to a bare generic "claude skill" search');
});

t('two different uncurated domains produce distinct fallback term sets', () => {
  const a = scout.terms({ domain: 'beekeeping' }, {}).terms;
  const b = scout.terms({ domain: 'candlemaking' }, {}).terms;
  assert.notDeepStrictEqual(a.slice().sort(), b.slice().sort());
});

t('keywords add extra tailored terms beyond the curated seed', () => {
  const r = scout.terms({ domain: 'website', keywords: ['shopify'] }, {});
  assert.ok(r.terms.some((x) => x.toLowerCase().includes('shopify')));
});

t('duplicate/blank keywords are deduped and ignored, never producing empty/duplicate entries', () => {
  const r = scout.terms({ domain: 'slides', keywords: ['powerpoint', 'powerpoint', '  ', ''] }, {});
  const lowered = r.terms.map((x) => x.toLowerCase());
  const countPowerpointSkill = lowered.filter((x) => x === 'claude powerpoint skill').length;
  assert.strictEqual(countPowerpointSkill, 1, 'seed + duplicate keyword must not double up the same term');
});

t('terms() throws on a missing domain', () => {
  assert.throws(() => scout.terms({}, {}), /domain/);
});

t('terms() throws on an empty-string domain', () => {
  assert.throws(() => scout.terms({ domain: '   ' }, {}), /domain/);
});

t('terms() result is capped at MAX_TERMS even with many keywords', () => {
  const manyKeywords = Array.from({ length: 20 }, (_, i) => 'kw' + i);
  const r = scout.terms({ domain: 'website', keywords: manyKeywords }, {});
  assert.ok(r.terms.length <= scout.MAX_TERMS, 'expected <= ' + scout.MAX_TERMS + ' terms, got ' + r.terms.length);
});

// ---------------------------------------------------------------------------
// 2) vetting ledger — record() / list() / isVetted(), missing ledger degrades honestly
// ---------------------------------------------------------------------------
console.log('\n2) vetting ledger: record/list/isVetted, honest missing-file degrade');

t('missing ledger file: list() returns an honest empty result, no crash', () => {
  const r = scout.list({ vettingPath: NOWHERE });
  assert.deepStrictEqual(r.entries, []);
});

t('missing ledger file: isVetted() returns null (never vetted), no crash', () => {
  const r = scout.isVetted('some-capability', { vettingPath: NOWHERE });
  assert.strictEqual(r, null);
});

t('record() appends an entry and it is retrievable via list()', () => {
  const p = freshLedgerPath('scout-record');
  const entry = scout.record({ capability: 'demo-skill', verdict: 'approve', reason: 'genuinely useful, no overlap', source: 'https://example.test/demo-skill' }, { vettingPath: p });
  assert.strictEqual(entry.capability, 'demo-skill');
  assert.strictEqual(entry.verdict, 'approve');
  assert.strictEqual(typeof entry.ts, 'string');
  const r = scout.list({ vettingPath: p });
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].capability, 'demo-skill');
});

t('a second record() call for a DIFFERENT capability appends, never overwrites the first entry', () => {
  const p = freshLedgerPath('scout-record-append');
  scout.record({ capability: 'skill-a', verdict: 'approve', reason: 'reason a' }, { vettingPath: p });
  scout.record({ capability: 'skill-b', verdict: 'hard-pass', reason: 'reason b' }, { vettingPath: p });
  const r = scout.list({ vettingPath: p });
  assert.strictEqual(r.entries.length, 2);
  assert.deepStrictEqual(r.entries.map((e) => e.capability).sort(), ['skill-a', 'skill-b']);
});

t('isVetted() on an unrecorded capability returns null', () => {
  const p = freshLedgerPath('scout-unvetted');
  scout.record({ capability: 'something-else', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  const r = scout.isVetted('never-recorded', { vettingPath: p });
  assert.strictEqual(r, null);
});

t('isVetted() on an approved capability returns that entry', () => {
  const p = freshLedgerPath('scout-approved');
  scout.record({ capability: 'my-approved-tool', verdict: 'approve', reason: 'clean, maintained, useful' }, { vettingPath: p });
  const r = scout.isVetted('my-approved-tool', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.verdict, 'approve');
});

t('capability lookup in isVetted() is case-insensitive', () => {
  const p = freshLedgerPath('scout-case');
  scout.record({ capability: 'MixedCase-Tool', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  const r = scout.isVetted('mixedcase-tool', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.capability, 'MixedCase-Tool');
});

// ---------------------------------------------------------------------------
// 3) THE CORE PERSISTENCE GUARANTEE — a HARD-PASS persists, is never overridden
//    by a later approve attempt for the same capability. (mutation-verify target)
// ---------------------------------------------------------------------------
console.log('\n3) a HARD-PASS persists — never overridden by a later approve');

t('a HARD-PASS recorded first, then an approve attempted for the SAME capability: isVetted() STILL returns the hard-pass', () => {
  const p = freshLedgerPath('scout-hardpass-first');
  scout.record({ capability: 'junk-plugin', verdict: 'hard-pass', reason: 'unmaintained, security risk' }, { vettingPath: p });
  scout.record({ capability: 'junk-plugin', verdict: 'approve', reason: 'someone tried to re-approve it later' }, { vettingPath: p });
  const r = scout.isVetted('junk-plugin', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.verdict, 'hard-pass', 'a later approve attempt must never override a recorded hard-pass');
  assert.strictEqual(r.reason, 'unmaintained, security risk');
});

t('an approve recorded first, then a HARD-PASS for the SAME capability: isVetted() reports the hard-pass (the stricter verdict always wins)', () => {
  const p = freshLedgerPath('scout-hardpass-second');
  scout.record({ capability: 'flip-flop-tool', verdict: 'approve', reason: 'looked fine at first' }, { vettingPath: p });
  scout.record({ capability: 'flip-flop-tool', verdict: 'hard-pass', reason: 'later found to be a security risk' }, { vettingPath: p });
  const r = scout.isVetted('flip-flop-tool', { vettingPath: p });
  assert.strictEqual(r.verdict, 'hard-pass');
  assert.strictEqual(r.reason, 'later found to be a security risk');
});

t('BOTH entries remain in the ledger after the override attempt (append-only — nothing was deleted/mutated)', () => {
  const p = freshLedgerPath('scout-hardpass-both-kept');
  scout.record({ capability: 'kept-both', verdict: 'hard-pass', reason: 'first verdict' }, { vettingPath: p });
  scout.record({ capability: 'kept-both', verdict: 'approve', reason: 'second attempt' }, { vettingPath: p });
  const r = scout.list({ vettingPath: p });
  const forCap = r.entries.filter((e) => e.capability === 'kept-both');
  assert.strictEqual(forCap.length, 2, 'both the original hard-pass and the later approve attempt must remain on record');
});

t('a hard-pass for capability X does not affect isVetted() for an unrelated capability Y', () => {
  const p = freshLedgerPath('scout-isolation');
  scout.record({ capability: 'bad-tool-x', verdict: 'hard-pass', reason: 'junk' }, { vettingPath: p });
  const r = scout.isVetted('good-tool-y', { vettingPath: p });
  assert.strictEqual(r, null);
});

// ---------------------------------------------------------------------------
// 4) record() input validation — throws, never silently accepts garbage
// ---------------------------------------------------------------------------
console.log('\n4) record() input validation throws on garbage input');

t('record() throws on a missing capability', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ verdict: 'approve', reason: 'x' }, { vettingPath: p }), /capability/);
});

t('record() throws on a blank capability', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: '   ', verdict: 'approve', reason: 'x' }, { vettingPath: p }), /capability/);
});

t('record() throws on a missing verdict', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', reason: 'x' }, { vettingPath: p }), /verdict/);
});

t('record() throws on an invalid verdict value', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'maybe', reason: 'x' }, { vettingPath: p }), /verdict/);
});

t('record() throws on a missing reason', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve' }, { vettingPath: p }), /reason/);
});

t('record() throws on a blank reason', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve', reason: '   ' }, { vettingPath: p }), /reason/);
});

t('record() with no source stores source:null (never fabricates a source)', () => {
  const p = freshLedgerPath('scout-no-source');
  const entry = scout.record({ capability: 'no-source-tool', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  assert.strictEqual(entry.source, null);
});

// ---------------------------------------------------------------------------
// 5) malformed ledger throws — fail closed, never a silent "nothing vetted" pass
// ---------------------------------------------------------------------------
console.log('\n5) malformed ledger throws — fail closed');

t('invalid JSON in the ledger file throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger file that is valid JSON but not an object throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger file missing the "entries" array throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1 }));
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger entry missing "capability" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ verdict: 'approve', reason: 'x' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /capability/);
});

t('a ledger entry with an invalid "verdict" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ capability: 'x', verdict: 'maybe', reason: 'x' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /verdict/);
});

t('a ledger entry missing "reason" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ capability: 'x', verdict: 'approve' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /reason/);
});

t('a malformed ledger is NEVER silently treated as "nothing vetted" — isVetted() also throws, not null', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => scout.isVetted('anything', { vettingPath: p }));
});

t('record() on a pre-existing malformed ledger throws instead of silently overwriting it clean', () => {
  const p = freshLedgerPath('scout-malformed-record');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve', reason: 'y' }, { vettingPath: p }));
});

// ---------------------------------------------------------------------------
// 6) CLI — real subprocess, exit codes, --json, FORGE_SCOUT_VETTING_PATH hermeticity
// ---------------------------------------------------------------------------
console.log('\n6) CLI (real spawned subprocess, hermetic via FORGE_SCOUT_VETTING_PATH)');

t('CLI terms --domain slides --json exits 0 and includes the tailored powerpoint term', () => {
  const r = runCLI(['terms', '--domain', 'slides', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.terms.includes('claude powerpoint skill'));
});

t('CLI terms with no --domain exits 2 (usage error)', () => {
  const r = runCLI(['terms']);
  assert.strictEqual(r.status, 2);
});

t('CLI record --json exits 0, writes to the FORGE_SCOUT_VETTING_PATH override, never the real repo ledger', () => {
  const p = freshLedgerPath('scout-cli-record');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  const r = runCLI(['record', '--capability', 'cli-tool', '--verdict', 'approve', '--reason', 'cli test reason', '--json'], env);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.capability, 'cli-tool');
  assert.ok(fs.existsSync(p), 'CLI record must write to the overridden path');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(onDisk.entries.length, 1);
});

t('CLI record with a missing required flag exits 2', () => {
  const r = runCLI(['record', '--capability', 'x']);
  assert.strictEqual(r.status, 2);
});

t('CLI list --json exits 0 and reflects a prior CLI record via the same env override', () => {
  const p = freshLedgerPath('scout-cli-list');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  runCLI(['record', '--capability', 'listed-tool', '--verdict', 'hard-pass', '--reason', 'junk'], env);
  const r = runCLI(['list', '--json'], env);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.entries.some((e) => e.capability === 'listed-tool' && e.verdict === 'hard-pass'));
});

t('CLI honors the hard-pass-persists rule end-to-end (record hard-pass, then approve, then list still shows hard-pass as the last-in verdict for downstream isVetted logic)', () => {
  const p = freshLedgerPath('scout-cli-persist');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  runCLI(['record', '--capability', 'cli-junk', '--verdict', 'hard-pass', '--reason', 'first verdict'], env);
  runCLI(['record', '--capability', 'cli-junk', '--verdict', 'approve', '--reason', 'later attempt'], env);
  const cliListed = JSON.parse(runCLI(['list', '--json'], env).stdout.trim());
  const forCap = cliListed.entries.filter((e) => e.capability === 'cli-junk');
  assert.strictEqual(forCap.length, 2, 'CLI must append, not overwrite');
  const vetted = scout.isVetted('cli-junk', { vettingPath: p });
  assert.strictEqual(vetted.verdict, 'hard-pass', 'isVetted() against the CLI-written ledger must still surface the persisted hard-pass');
});

t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});

t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

// ---------------------------------------------------------------------------
// 6b) discovery sources — skills.sh is listed, and ALWAYS as an uncurated source
// ---------------------------------------------------------------------------
console.log('\n6b) terms() discovery sources (skills.sh is uncurated, never a trust signal)');

const SKILLS_SH = 'skills.sh (vercel-labs/skills, npx skills search)';

t('terms() lists skills.sh as a discovery source, flagged curated:false with its no-review note', () => {
  const r = scout.terms({ domain: 'website' }, {});
  assert.ok(Array.isArray(r.sources), 'terms() must return a sources array');
  const s = r.sources.find((x) => x.name === SKILLS_SH);
  assert.ok(s, 'skills.sh source missing: ' + JSON.stringify(r.sources));
  assert.strictEqual(s.url, 'https://skills.sh');
  assert.strictEqual(s.curated, false, 'skills.sh must be flagged uncurated');
  assert.ok(/never a trust signal/.test(s.note) && /APPROVE\/HARD-PASS still applies/.test(s.note), 'note must say it is no trust signal and vetting still applies: ' + s.note);
});

t('the uncurated source is present for curated AND fallback domains alike (not domain-dependent)', () => {
  for (const d of ['slides', 'beekeeping']) {
    const s = scout.terms({ domain: d }, {}).sources.find((x) => x.name === SKILLS_SH);
    assert.ok(s && s.curated === false, d + ': ' + JSON.stringify(s));
  }
});

t('editing a returned source cannot flip the shared list to curated (callers get copies)', () => {
  const first = scout.terms({ domain: 'website' }, {});
  first.sources[0].curated = true;
  const again = scout.terms({ domain: 'website' }, {}).sources.find((x) => x.name === SKILLS_SH);
  assert.strictEqual(again.curated, false);
  assert.strictEqual(scout.DISCOVERY_SOURCES.find((x) => x.name === SKILLS_SH).curated, false);
});

t('CLI terms --json carries the uncurated skills.sh source; the human output labels it [UNCURATED]', () => {
  const j = runCLI(['terms', '--domain', 'website', '--json']);
  assert.strictEqual(j.status, 0);
  const parsed = JSON.parse(j.stdout.trim());
  assert.ok(parsed.sources.some((x) => x.url === 'https://skills.sh' && x.curated === false), JSON.stringify(parsed.sources));
  const h = runCLI(['terms', '--domain', 'website']);
  assert.strictEqual(h.status, 0);
  assert.ok(/https:\/\/skills\.sh \[UNCURATED\]/.test(h.stdout), h.stdout);
});

// ---------------------------------------------------------------------------
// 7) real repo integration — the actual project ledger path resolves and is either absent
//    (fresh project, honest) or well-formed (never malformed) — read-only check, no writes here.
// ---------------------------------------------------------------------------
console.log('\n7) real repo integration (read-only)');

t('the real project ledger (if present) is well-formed; if absent, list() degrades honestly with no crash', () => {
  // No opts.vettingPath / env override here on purpose — this is the one deliberate read of the REAL
  // default path, proving the fresh-project "not present yet" case degrades honestly rather than crashing.
  const r = scout.list({});
  assert.ok(Array.isArray(r.entries));
});

// ---------------------------------------------------------------------------
// 8) TEMPLATE/USER SPLIT (external audit N4) — record() in DEFAULT mode (no vettingPath, no
//    FORGE_SCOUT_VETTING_PATH) writes ONLY to the never-shipped USER_CONFIG_PATH; list()/isVetted() merge
//    it with the shipped CONFIG_PATH baseline. These tests touch the REAL default files ONCE each and
//    restore them to their exact prior state afterward (snapshot/restore), so the suite stays hermetic
//    overall even though it proves the real default write path, not just a fixture stand-in.
// ---------------------------------------------------------------------------
console.log('\n8) template/user split (default mode touches the real files once, then restores them)');

t('CONFIG_PATH (shipped baseline) and USER_CONFIG_PATH (accumulated ledger) are two distinct files', () => {
  assert.notStrictEqual(scout.CONFIG_PATH, scout.USER_CONFIG_PATH);
});

function withRealUserLedgerRestored(fn) {
  const existed = fs.existsSync(scout.USER_CONFIG_PATH);
  const before = existed ? fs.readFileSync(scout.USER_CONFIG_PATH, 'utf8') : null;
  try { fn(); }
  finally {
    if (existed) fs.writeFileSync(scout.USER_CONFIG_PATH, before, 'utf8');
    else { try { fs.rmSync(scout.USER_CONFIG_PATH); } catch {} }
  }
}

t('record() in DEFAULT mode (no override at all) writes ONLY to USER_CONFIG_PATH — the shipped CONFIG_PATH baseline is byte-for-byte untouched', () => {
  withRealUserLedgerRestored(() => {
    const templateBefore = fs.readFileSync(scout.CONFIG_PATH, 'utf8');
    const cap = 'split-fix-probe-' + Date.now();
    const entry = scout.record({ capability: cap, verdict: 'approve', reason: 'default-mode write-target probe' }, {});
    assert.strictEqual(fs.readFileSync(scout.CONFIG_PATH, 'utf8'), templateBefore, 'record() in default mode must never touch the shipped template');
    assert.ok(fs.existsSync(scout.USER_CONFIG_PATH), 'record() in default mode must create/use the user ledger file');
    const userOnDisk = JSON.parse(fs.readFileSync(scout.USER_CONFIG_PATH, 'utf8'));
    assert.ok(userOnDisk.entries.some((e) => e.capability === cap), 'the new entry must land in the user ledger');
    assert.strictEqual(entry.capability, cap);
  });
});

t('list()/isVetted() in DEFAULT mode merge the shipped baseline with the accumulated user ledger', () => {
  withRealUserLedgerRestored(() => {
    const cap = 'split-fix-merge-probe-' + Date.now();
    scout.record({ capability: cap, verdict: 'hard-pass', reason: 'merge probe' }, {});
    const merged = scout.list({});
    assert.ok(merged.entries.some((e) => e.capability === cap), 'a user-ledger-only entry must be visible through the merged list()');
    // every entry that is really in the shipped template must also be visible through the merge
    const templateEntries = scout.loadLedgerFile(scout.CONFIG_PATH).entries;
    assert.ok(templateEntries.length > 0, 'sanity: the shipped baseline is not empty');
    for (const te of templateEntries.slice(0, 3)) {
      assert.ok(merged.entries.some((e) => e.capability === te.capability && e.ts === te.ts), 'shipped baseline entry missing from the merge: ' + te.capability);
    }
    const vetted = scout.isVetted(cap, {});
    assert.ok(vetted && vetted.verdict === 'hard-pass', 'isVetted() in default mode must see the just-recorded entry through the merge');
  });
});

t('the hard-pass-persists rule still holds end-to-end in DEFAULT mode across two record() calls for the same capability', () => {
  withRealUserLedgerRestored(() => {
    const cap = 'split-fix-persist-probe-' + Date.now();
    scout.record({ capability: cap, verdict: 'hard-pass', reason: 'first verdict' }, {});
    scout.record({ capability: cap, verdict: 'approve', reason: 'later attempt' }, {});
    const vetted = scout.isVetted(cap, {});
    assert.strictEqual(vetted.verdict, 'hard-pass', 'a later approve in default mode must never override a persisted hard-pass');
  });
});

t('N4 fix: the shipped baseline\'s frontend-design entry is corrected to approve — a curated baseline must not permanently hard-pass a skill the product itself vendors', () => {
  const templateEntries = scout.loadLedgerFile(scout.CONFIG_PATH).entries;
  const original = templateEntries.find((e) => e.capability === 'frontend-design (anthropics/skills)');
  assert.ok(original, 'the original frontend-design entry must still exist (audit trail kept, not deleted)');
  assert.strictEqual(original.verdict, 'approve', 'the stale hard-pass must be corrected now that frontend-design is vendored into the product');
});

// ---------------------------------------------------------------------------
// 9) rank() —: name match, then description, source, maintenance; web-only mentions last;
//    capped at 10; a prior HARD-PASS is skipped, never re-ranked. adoptPlan() — a fresh branch + reviewed diff.
// ---------------------------------------------------------------------------
console.log('\n9) rank() + adoptPlan() (WP-S5)');

const NOW = Date.parse('2026-10-24T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const names = (r) => r.ranked.map((x) => x.name);

t('name match beats description: "n8n-workflow-builder" outranks a better-described "flow-helper"', () => {
  const r = scout.rank([
    { name: 'flow-helper', description: 'n8n workflow builder for n8n flows', url: 'https://github.com/a/flow-helper', updated: daysAgo(5) },
    { name: 'n8n-workflow-builder', description: 'builds things', url: 'https://github.com/b/n8n-workflow-builder', updated: daysAgo(5) },
  ], { query: 'claude n8n workflow skill', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['n8n-workflow-builder', 'flow-helper']);
});

t('generic words (claude, skill, plugin, mcp, code) never count as a name match', () => {
  const r = scout.rank([
    { name: 'claude-skill-pack', description: 'misc', url: 'https://github.com/x/p', updated: daysAgo(5) },
    { name: 'astro-kit', description: 'misc', url: 'https://github.com/x/a', updated: daysAgo(5) },
  ], { query: 'claude astro skill', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['astro-kit', 'claude-skill-pack']);
  assert.strictEqual(r.ranked[1].scores.name, 0);
});

t('equal name: description match decides', () => {
  const r = scout.rank([
    { name: 'astro-a', description: 'unrelated', url: 'https://github.com/x/1', updated: daysAgo(5) },
    { name: 'astro-b', description: 'astro content collections helper', url: 'https://github.com/x/2', updated: daysAgo(5) },
  ], { query: 'astro content collection', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['astro-b', 'astro-a']);
});

t('equal name + description: source decides (official > curated > repo > listing)', () => {
  const base = { description: 'slides', updated: daysAgo(5) };
  const r = scout.rank([
    { ...base, name: 'slides-l', source_kind: 'listing', url: 'https://skills.sh/x' },
    { ...base, name: 'slides-r', source_kind: 'repo', url: 'https://github.com/x/r' },
    { ...base, name: 'slides-o', source_kind: 'official', url: 'https://github.com/anthropics/x' },
    { ...base, name: 'slides-c', source_kind: 'curated', url: 'https://github.com/x/c' },
  ], { query: 'slides', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['slides-o', 'slides-c', 'slides-r', 'slides-l']);
});

t('source kind is derived from the url when not given (github repo = repo, skills.sh = listing)', () => {
  assert.strictEqual(scout.sourceKind({ url: 'https://github.com/a/b' }), 'repo');
  assert.strictEqual(scout.sourceKind({ url: 'https://www.npmjs.com/package/x' }), 'repo');
  assert.strictEqual(scout.sourceKind({ url: 'https://skills.sh/a' }), 'listing');
  assert.strictEqual(scout.sourceKind({ url: 'https://someblog.example/post' }), 'web');
  assert.strictEqual(scout.sourceKind({}), 'web');
});

t('equal up to source: maintenance decides (recent > within a year > unknown > stale)', () => {
  const base = { description: 'game', url: 'https://github.com/x/y' };
  const r = scout.rank([
    { ...base, name: 'game-stale', updated: daysAgo(800) },
    { ...base, name: 'game-unknown' },
    { ...base, name: 'game-year', updated: daysAgo(200) },
    { ...base, name: 'game-fresh', updated: daysAgo(10) },
  ], { query: 'game', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['game-fresh', 'game-year', 'game-unknown', 'game-stale']);
});

t('web-only mentions rank after every candidate with a source, even with a better name match', () => {
  const r = scout.rank([
    { name: 'voice-agent', description: 'voice agent', web_only: true, url: 'https://someblog.example/voice' },
    { name: 'phone-thing', description: 'misc', url: 'https://github.com/x/p', updated: daysAgo(900) },
  ], { query: 'voice agent', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['phone-thing', 'voice-agent']);
  assert.strictEqual(r.ranked[1].web_only, true);
});

t('a candidate with no url at all counts as a web-only mention', () => {
  const r = scout.rank([{ name: 'x-rag' }, { name: 'y', url: 'https://github.com/a/y' }], { query: 'rag', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['y', 'x-rag']);
});

t('capped at 10: the rest is listed in dropped, never silently lost; a larger cap is clamped to 10', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ name: 'tool-' + String(i).padStart(2, '0'), url: 'https://github.com/x/' + i }));
  const r = scout.rank(many, { query: 'tool', now: NOW, vettingPath: NOWHERE, cap: 50 });
  assert.strictEqual(r.ranked.length, 10);
  assert.strictEqual(r.dropped.length, 4);
  assert.strictEqual(r.cap, 10);
  const r3 = scout.rank(many, { query: 'tool', now: NOW, vettingPath: NOWHERE, cap: 3 });
  assert.strictEqual(r3.ranked.length, 3);
});

t('ranking is deterministic: full ties are broken by name, and rank numbers start at 1', () => {
  const r = scout.rank([{ name: 'b', url: 'https://github.com/x/b' }, { name: 'a', url: 'https://github.com/x/a' }], { query: 'zzz', now: NOW, vettingPath: NOWHERE });
  assert.deepStrictEqual(names(r), ['a', 'b']);
  assert.deepStrictEqual(r.ranked.map((x) => x.rank), [1, 2]);
});

t('a prior HARD-PASS is skipped (never re-ranked); a prior approve is ranked and marked already vetted', () => {
  const p = freshLedgerPath('forge-scout-rank');
  scout.record({ capability: 'junk-tool', verdict: 'hard-pass', reason: 'vaporware' }, { vettingPath: p });
  scout.record({ capability: 'good-tool', verdict: 'approve', reason: 'useful' }, { vettingPath: p });
  const r = scout.rank([{ name: 'junk-tool', url: 'https://github.com/x/j' }, { name: 'good-tool', url: 'https://github.com/x/g' }], { query: 'tool', now: NOW, vettingPath: p });
  assert.deepStrictEqual(names(r), ['good-tool']);
  assert.strictEqual(r.ranked[0].prior_verdict, 'approve');
  assert.deepStrictEqual(r.skipped_hard_pass, ['junk-tool']);
});

t('rank() validates input: a non-list or a candidate without a name throws', () => {
  assert.throws(() => scout.rank('x', { query: 'q', vettingPath: NOWHERE }), /list/);
  assert.throws(() => scout.rank([{ description: 'no name' }], { query: 'q', vettingPath: NOWHERE }), /name/);
});

t('adoptPlan() for an APPROVED capability: a fresh scout/adopt-<slug>-<date> branch, a reviewed diff, owner merge', () => {
  const p = freshLedgerPath('forge-scout-adopt');
  scout.record({ capability: 'Astro Kit (x/astro-kit)', verdict: 'approve', reason: 'fits' }, { vettingPath: p });
  const plan = scout.adoptPlan('Astro Kit (x/astro-kit)', { vettingPath: p, now: NOW });
  assert.strictEqual(plan.branch, 'scout/adopt-astro-kit-x-astro-kit-20261024');
  assert.ok(plan.steps.some((s) => /git switch -c scout\/adopt-astro-kit-x-astro-kit-20261024/.test(s)), JSON.stringify(plan.steps));
  assert.ok(plan.steps.some((s) => /diff/.test(s) && /forge-code-review|Review Boss/.test(s)), JSON.stringify(plan.steps));
  assert.ok(plan.steps.some((s) => /owner/.test(s) && /merge/.test(s)), JSON.stringify(plan.steps));
});

t('adoptPlan() refuses a hard-passed or never-vetted capability (throws with the reason)', () => {
  const p = freshLedgerPath('forge-scout-adopt-refuse');
  scout.record({ capability: 'bad', verdict: 'hard-pass', reason: 'security risk' }, { vettingPath: p });
  assert.throws(() => scout.adoptPlan('bad', { vettingPath: p, now: NOW }), /hard-pass/);
  assert.throws(() => scout.adoptPlan('never-seen', { vettingPath: p, now: NOW }), /not vetted/);
});

t('CLI rank --candidates <file> --json ranks and caps; a bad file exits 2', () => {
  const dir = freshDir('forge-scout-rank-cli');
  const f = path.join(dir, 'cands.json');
  fs.writeFileSync(f, JSON.stringify({ candidates: [{ name: 'misc', url: 'https://github.com/x/m' }, { name: 'n8n-kit', url: 'https://github.com/x/n' }] }));
  const r = runCLI(['rank', '--query', 'n8n', '--candidates', f, '--json'], { ...process.env, FORGE_SCOUT_VETTING_PATH: NOWHERE });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).ranked.map((x) => x.name), ['n8n-kit', 'misc']);
  fs.writeFileSync(f, '{not json');
  const bad = runCLI(['rank', '--query', 'n8n', '--candidates', f], { ...process.env, FORGE_SCOUT_VETTING_PATH: NOWHERE });
  assert.strictEqual(bad.status, 2);
});

t('CLI adopt-plan exits 3 for a capability that is not approved, 0 with the plan for an approved one', () => {
  const p = freshLedgerPath('forge-scout-adopt-cli');
  scout.record({ capability: 'ok-tool', verdict: 'approve', reason: 'fits' }, { vettingPath: p });
  const env = { ...process.env, FORGE_SCOUT_VETTING_PATH: p };
  const ok = runCLI(['adopt-plan', '--capability', 'ok-tool', '--json'], env);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(/^scout\/adopt-ok-tool-\d{8}$/.test(JSON.parse(ok.stdout).branch), ok.stdout);
  const no = runCLI(['adopt-plan', '--capability', 'other'], env);
  assert.strictEqual(no.status, 3, no.stdout + no.stderr);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
