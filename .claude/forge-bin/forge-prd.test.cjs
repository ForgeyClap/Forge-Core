#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-prd.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override (shared with forge-store.cjs); never touches the real project's .claude/.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');

// hermetic: point the shared store at a throwaway temp dir BEFORE requiring forge-prd.cjs (it requires
// forge-store.cjs internally, which resolves CLAUDE_DIR once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prd-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const { renderPrd, writePrd, criteriaToTickets, openClarifications, amendTicket } = require('./forge-prd.cjs');
const store = require('./forge-store.cjs');
const lockGuard = require('./forge-lock-guard.cjs');
const { spawnSync } = require('child_process');
const CLI = path.join(__dirname, 'forge-prd.cjs');
function runCli(args) {
  return spawnSync(process.execPath, [CLI].concat(args), { env: Object.assign({}, process.env, { FORGE_STORE_ROOT: TMP }), encoding: 'utf8' });
}

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-prd offline tests (hermetic root=' + TMP + ')');

// 1) renderPrd includes all 13 section headings; a missing section renders "(not specified)"
const HEADINGS = ['Goal', 'Users', 'Problem', 'Solution', 'Modules', 'User Stories', 'MVP Scope', 'Non-Goals', 'Architecture', 'Risks', 'Acceptance Criteria', 'Test Plan', 'Roadmap'];
const bareMd = renderPrd({ prd_id: 'prd-bare', title: 'Bare PRD', sections: { goal: 'Ship the thing' } });
t('renderPrd includes all 13 section headings', HEADINGS.every((h) => bareMd.includes('## ' + h)));
t('renderPrd never crashes on a partial PRD', typeof bareMd === 'string' && bareMd.length > 0);
t('a missing section renders "(not specified)"', bareMd.includes('(not specified)'));
t('the one section that IS set does not render as not specified', /## Goal\s*\n+Ship the thing/.test(bareMd));
t('renderPrd never crashes on a null/undefined prd', typeof renderPrd(null) === 'string' && typeof renderPrd(undefined) === 'string');

// 2) writePrd creates <id>.md + <id>.meta.json + index.jsonl row
const prdFull = {
  prd_id: 'prd-full-001', title: 'Full PRD', project: 'demo-project',
  sections: {
    goal: 'Build WP3', users: ['end user', 'admin'], problem: 'No PRD generator exists',
    solution: 'Zero-dep PRD writer', modules: ['forge-prd.cjs', 'dashboard panel'],
    user_stories: ['As a Lead I want a PRD so that work is scoped'],
    mvp_scope: 'markdown + meta + tickets', non_goals: 'no external deps',
    architecture: 'flat-file store', risks: ['scope creep'],
    acceptance_criteria: [
      { id: 'ac-1', text: 'renderPrd produces all sections', owner: 'coder', required_tests: ['forge-prd.test.cjs'] },
      { text: 'writePrd creates md+meta+index row' },
    ],
    test_plan: 'hermetic FORGE_STORE_ROOT tests', roadmap: 'WP3 -> WP4',
  },
};
const written = writePrd(prdFull);
t('writePrd returns prd_id/mdPath/metaPath', written.prd_id === 'prd-full-001' && !!written.mdPath && !!written.metaPath);
t('writePrd creates the .md file', fs.existsSync(written.mdPath));
t('writePrd creates the .meta.json file', fs.existsSync(written.metaPath));
const idxPath = path.join(TMP, 'forge-prd', 'index.jsonl');
t('writePrd appends a row to forge-prd/index.jsonl', fs.existsSync(idxPath) && fs.readFileSync(idxPath, 'utf8').includes('prd-full-001'));
const metaJson = JSON.parse(fs.readFileSync(written.metaPath, 'utf8'));
t('meta.json carries a _generated ISO timestamp', typeof metaJson._generated === 'string' && !Number.isNaN(Date.parse(metaJson._generated)));
t('meta.json round-trips the title', metaJson.title === 'Full PRD');
t('written .md includes both acceptance criteria', fs.readFileSync(written.mdPath, 'utf8').includes('renderPrd produces all sections') && fs.readFileSync(written.mdPath, 'utf8').includes('writePrd creates md+meta+index row'));

// 3) secret redaction — fake secret ABSENT from BOTH the .md and the .meta.json
const FAKE_SECRET = 'nvapi-FAKEFAKEFAKEFAKE1234567890';
const prdSecret = {
  prd_id: 'prd-secret-001', title: 'Secret PRD',
  sections: { goal: 'leaked key: ' + FAKE_SECRET, acceptance_criteria: ['no secrets in output'] },
};
const writtenSecret = writePrd(prdSecret);
const mdText = fs.readFileSync(writtenSecret.mdPath, 'utf8');
const metaText = fs.readFileSync(writtenSecret.metaPath, 'utf8');
t('fake secret ABSENT from the written .md', !mdText.includes(FAKE_SECRET));
t('fake secret ABSENT from the written .meta.json', !metaText.includes(FAKE_SECRET));
t('redaction marker present in the .md', mdText.includes('***REDACTED***'));

// 4) criteriaToTickets — 2 criteria -> 2 tickets, status open, prd_id set
const ticketIds = criteriaToTickets(prdFull);
t('criteriaToTickets creates 2 tickets', ticketIds.length === 2);
for (const tid of ticketIds) {
  const ticket = store.getEntity('tickets', tid);
  t('ticket ' + tid + ' has status open', ticket.status === 'open');
  t('ticket ' + tid + ' carries prd_id', ticket.prd_id === 'prd-full-001');
}
t('criteriaToTickets on a PRD with no acceptance_criteria returns []', criteriaToTickets({ prd_id: 'prd-empty', sections: {} }).length === 0);

// 5) invalid prd_id ("../x") is rejected
let rejected = false;
try { writePrd({ prd_id: '../x', title: 'bad', sections: {} }); } catch (e) { rejected = /invalid prd_id/i.test(e.message); }
t('invalid prd_id "../x" is REJECTED', rejected === true);
t('bad-id write did not escape forge-prd/', !fs.existsSync(path.join(TMP, 'x.md')));

// =====================================================================================================
// 6) / M1 + M5 — 'assumptions', 'invariants', 'stop_bound' sections; render ONLY when present
// =====================================================================================================

// fc-1: an OLD-SHAPE PRD (no assumptions/invariants/stop_bound) must render BYTE-IDENTICAL to a
// rendering of the SAME PRD taken from the code BEFORE this change (captured literally, not recomputed,
// so a regression in the new optional-section logic cannot silently "prove itself" correct).
const legacyPrd = {
  prd_id: 'prd-legacy-001', title: 'Legacy Shape PRD', project: 'demo-project', created: '2026-01-01',
  sections: {
    goal: 'Ship the thing', users: ['end user', 'admin'], problem: 'No PRD generator exists',
    solution: 'Zero-dep PRD writer', modules: ['forge-prd.cjs'],
    user_stories: ['As a Lead I want a PRD'],
    mvp_scope: 'markdown + meta', non_goals: 'no external deps',
    architecture: 'flat-file store', risks: ['scope creep'],
    acceptance_criteria: [{ id: 'ac-1', text: 'renders all sections' }],
    failure_conditions: [{ id: 'fc-1', text: 'looks generic' }],
    test_plan: 'hermetic tests', roadmap: 'WP3 -> WP4',
  },
};
const LEGACY_EXPECTED = "# Legacy Shape PRD\n\n_prd_id: prd-legacy-001 · project: demo-project · created: 2026-01-01_\n\n## Goal\n\nShip the thing\n\n## Users\n\n- end user\n- admin\n\n## Problem\n\nNo PRD generator exists\n\n## Solution\n\nZero-dep PRD writer\n\n## Modules\n\n- forge-prd.cjs\n\n## User Stories\n\n- As a Lead I want a PRD\n\n## MVP Scope\n\nmarkdown + meta\n\n## Non-Goals\n\nno external deps\n\n## Architecture\n\nflat-file store\n\n## Risks\n\n- scope creep\n\n## Acceptance Criteria\n\n- **ac-1** — renders all sections\n\n## Failure Conditions\n\n- **fc-1** — looks generic\n\n## Test Plan\n\nhermetic tests\n\n## Roadmap\n\nWP3 -> WP4\n";
t('fc-1: an old-shape PRD (no assumptions/invariants/stop_bound) renders byte-identical to before', renderPrd(legacyPrd) === LEGACY_EXPECTED);

const withAssumptions = renderPrd(Object.assign({}, legacyPrd, { prd_id: 'prd-assume-1', sections: Object.assign({}, legacyPrd.sections, { assumptions: 'guessed the target browser is Chrome' }) }));
t('assumptions renders under "Assumptions (auto-filled)" when present', withAssumptions.includes('## Assumptions (auto-filled)') && withAssumptions.includes('guessed the target browser is Chrome'));
t('Assumptions sits right after Non-Goals (and before Architecture)', withAssumptions.indexOf('## Assumptions (auto-filled)') > withAssumptions.indexOf('## Non-Goals') && withAssumptions.indexOf('## Assumptions (auto-filled)') < withAssumptions.indexOf('## Architecture'));
t('a PRD without assumptions has NO "Assumptions (auto-filled)" heading at all', !renderPrd(legacyPrd).includes('Assumptions (auto-filled)'));

const withInvariants = renderPrd(Object.assign({}, legacyPrd, { prd_id: 'prd-inv-1', sections: Object.assign({}, legacyPrd.sections, { invariants: ['the session must never leak across tenants'] }) }));
t('invariants renders under "Invariants" when present', withInvariants.includes('## Invariants') && withInvariants.includes('the session must never leak across tenants'));
t('Invariants sits right after Failure Conditions', withInvariants.indexOf('## Invariants') > withInvariants.indexOf('## Failure Conditions'));
t('a PRD without invariants has NO "Invariants" heading at all', !renderPrd(legacyPrd).includes('## Invariants'));

const withInvItems = renderPrd(Object.assign({}, legacyPrd, { prd_id: 'prd-inv-2', sections: Object.assign({}, legacyPrd.sections, { invariants: [{ text: 'no cross-tenant reads' }, { id: 'inv-custom', text: 'no silent guesses' }] }) }));
t('an invariant without an explicit id defaults to inv-1', /\*\*inv-1\*\*/.test(withInvItems));
t('an invariant with an explicit id keeps it', /\*\*inv-custom\*\*/.test(withInvItems));

const withStopBound = renderPrd(Object.assign({}, legacyPrd, { prd_id: 'prd-sb-1', sections: Object.assign({}, legacyPrd.sections, { invariants: ['x'], stop_bound: 'stop after 3 failed attempts' }) }));
t('stop_bound renders under "Stop Bound" when present', withStopBound.includes('## Stop Bound') && withStopBound.includes('stop after 3 failed attempts'));
t('Stop Bound sits right after Invariants', withStopBound.indexOf('## Stop Bound') > withStopBound.indexOf('## Invariants'));
t('a PRD without stop_bound has NO "Stop Bound" heading at all', !renderPrd(legacyPrd).includes('## Stop Bound'));

t('an empty-array invariants / empty-string assumptions / blank stop_bound render as ABSENT, not "(not specified)"', (() => {
  const md = renderPrd({ prd_id: 'prd-empty-opt', title: 'x', sections: { goal: 'g', assumptions: '', invariants: [], stop_bound: '   ' } });
  return !md.includes('Assumptions (auto-filled)') && !md.includes('## Invariants') && !md.includes('## Stop Bound');
})());

// =====================================================================================================
// 7) openClarifications(prd) — [NEEDS CLARIFICATION: ...] markers in prose, array entries, item text
// =====================================================================================================
t('openClarifications returns [] for a null/undefined/malformed PRD',
  openClarifications(null).length === 0 &&
  openClarifications(undefined).length === 0 &&
  openClarifications({}).length === 0 &&
  openClarifications({ sections: 'not-an-object' }).length === 0);

const prdMarkers = {
  prd_id: 'prd-clar-1', title: 'Clarify',
  sections: {
    goal: 'Ship the thing, but [NEEDS CLARIFICATION: which region first?]',
    users: ['[NEEDS CLARIFICATION: internal or external users?]', 'admin'],
    non_goals: 'resolved: [CLARIFIED: no mobile app for wave 1]',
    acceptance_criteria: [
      { id: 'ac-1', text: 'the page loads [NEEDS CLARIFICATION: which page?]' },
      { text: 'a resolved one stays closed [CLARIFIED: the login page]' },
    ],
    invariants: [{ text: 'no data loss [NEEDS CLARIFICATION: what counts as data loss?]' }],
  },
};
const open = openClarifications(prdMarkers);
t('openClarifications finds the prose marker in goal', open.some((m) => m.section === 'goal' && m.id === null && m.question === 'which region first?'));
t('openClarifications finds the array-entry marker in users', open.some((m) => m.section === 'users' && m.id === null && m.question === 'internal or external users?'));
t('openClarifications does NOT report the resolved [CLARIFIED: ...] marker in non_goals', !open.some((m) => m.section === 'non_goals'));
t('openClarifications finds the item-text marker in acceptance_criteria, carrying its id', open.some((m) => m.section === 'acceptance_criteria' && m.id === 'ac-1' && m.question === 'which page?'));
t('openClarifications does NOT report the resolved item in acceptance_criteria', !open.some((m) => m.section === 'acceptance_criteria' && /login page/.test(m.question)));
t('openClarifications finds the item-text marker in invariants, defaulting the id to inv-1', open.some((m) => m.section === 'invariants' && m.id === 'inv-1' && m.question === 'what counts as data loss?'));
t('openClarifications total count is exactly 4 (goal, users, ac-1, inv-1)', open.length === 4);
t('openClarifications returns markers in document order', JSON.stringify(open.map((m) => m.section)) === JSON.stringify(['goal', 'users', 'acceptance_criteria', 'invariants']));
t('openClarifications is pure (same input -> same output on a second call)', JSON.stringify(openClarifications(prdMarkers)) === JSON.stringify(open));
t('openClarifications also scans a non-standard section key (any string anywhere in prd.sections)', openClarifications({ sections: { some_custom_field: '[NEEDS CLARIFICATION: is this even used?]' } }).some((m) => m.section === 'some_custom_field' && m.question === 'is this even used?'));
t('openClarifications never throws on a weird shape (numbers/nulls mixed into arrays)', (() => {
  try { return Array.isArray(openClarifications({ sections: { goal: 42, users: [1, { text: 5 }, null] } })); }
  catch (e) { return false; }
})());

// =====================================================================================================
// 8) CLI: node forge-prd.cjs clarifications <prd_id> — exit 3 (open) / 0 (none) / 1 (bad id or missing)
// =====================================================================================================
writePrd(prdMarkers);
const rOpen = runCli(['clarifications', 'prd-clar-1']);
t('CLI clarifications exits 3 when markers are open', rOpen.status === 3);
t('CLI clarifications prints "<section>[/<id>]: <question>" per open marker',
  rOpen.stdout.includes('goal: which region first?') &&
  rOpen.stdout.includes('users: internal or external users?') &&
  rOpen.stdout.includes('acceptance_criteria/ac-1: which page?') &&
  rOpen.stdout.includes('invariants/inv-1: what counts as data loss?'));

writePrd({ prd_id: 'prd-clar-resolved', title: 'Resolved', sections: { goal: 'all good [CLARIFIED: yes]' } });
const rNone = runCli(['clarifications', 'prd-clar-resolved']);
t('CLI clarifications exits 0 when no markers are open', rNone.status === 0);
t('CLI clarifications prints nothing when no markers are open', rNone.stdout.trim() === '');

const rBadId = runCli(['clarifications', '../evil']);
t('CLI clarifications exits 1 on a bad id', rBadId.status === 1);

const rMissing = runCli(['clarifications', 'prd-does-not-exist']);
t('CLI clarifications exits 1 on a missing prd', rMissing.status === 1);

// =====================================================================================================
// 9) write/render report open markers: "open clarifications: N" printed after the existing output
// =====================================================================================================
const rRender = runCli(['render', JSON.stringify(prdMarkers)]);
t('CLI render prints "open clarifications: N" when N >= 1', /open clarifications: 4/.test(rRender.stdout));

const rRenderClean = runCli(['render', JSON.stringify({ prd_id: 'x', title: 'x', sections: { goal: 'all good' } })]);
t('CLI render prints NO "open clarifications" line when there are none', !/open clarifications/.test(rRenderClean.stdout));

const rWrite = runCli(['write', JSON.stringify({ prd_id: 'prd-clar-write-1', title: 'w', sections: { goal: '[NEEDS CLARIFICATION: which env?]' } })]);
t('CLI write prints "open clarifications: 1" after the existing output', /open clarifications: 1/.test(rWrite.stdout) && /PRD written: prd-clar-write-1/.test(rWrite.stdout));

const rWriteClean = runCli(['write', JSON.stringify({ prd_id: 'prd-clar-write-2', title: 'w', sections: { goal: 'all good' } })]);
t('CLI write prints NO "open clarifications" line when there are none', !/open clarifications/.test(rWriteClean.stdout));

// v2.9.2-dev (found by dogfooding on the PRD): a PRD that DESCRIBES the syntax, with a placeholder
// instead of a question, must not count as an open question, or writing about the feature blocks work.
const docOnly = { sections: {
  modules: ['M1: a [NEEDS CLARIFICATION: ...] marker', 'an ellipsis [NEEDS CLARIFICATION: …]', 'empty [NEEDS CLARIFICATION: ]', 'placeholder [NEEDS CLARIFICATION: <question>]', 'plain [NEEDS CLARIFICATION: <plain question>]'],
  goal: 'a real one: [NEEDS CLARIFICATION: which payment provider?]',
} };
const docRes = openClarifications(docOnly);
t('placeholder markers (..., …, empty, <question>) are documentation, not open questions', docRes.length === 1 && docRes[0].question === 'which payment provider?', JSON.stringify(docRes));

// =====================================================================================================
// 10) W1-01/W1-02/W1-03 — review fixes (see codex-w1.out)
// =====================================================================================================

// W1-01a: a SINGLE item object (not wrapped in an array) in acceptance_criteria / failure_conditions /
// invariants must be scanned exactly like the renderer accepts it (renderSectionBody wraps a lone object
// into a one-item array) — the marker must not silently disappear.
const singletonPrd = {
  prd_id: 'prd-singleton-1', title: 'Singleton items',
  sections: {
    goal: 'g',
    acceptance_criteria: { id: 'ac-1', text: 'ships [NEEDS CLARIFICATION: which release channel?]' },
    failure_conditions: { text: 'breaks prod [NEEDS CLARIFICATION: what counts as broken?]' },
    invariants: { text: 'no data loss [NEEDS CLARIFICATION: what counts as data loss?]' },
  },
};
const singletonOpen = openClarifications(singletonPrd);
t('W1-01a: a singleton (non-array) acceptance_criteria object is scanned, carrying its explicit id',
  singletonOpen.some((m) => m.section === 'acceptance_criteria' && m.id === 'ac-1' && m.question === 'which release channel?'));
t('W1-01a: a singleton failure_conditions object is scanned, defaulting its id to fc-1',
  singletonOpen.some((m) => m.section === 'failure_conditions' && m.id === 'fc-1' && m.question === 'what counts as broken?'));
t('W1-01a: a singleton invariants object is scanned, defaulting its id to inv-1',
  singletonOpen.some((m) => m.section === 'invariants' && m.id === 'inv-1' && m.question === 'what counts as data loss?'));

// W1-01b: placeholder recognition is limited to EXACTLY the documented forms — any OTHER angle-bracket
// text, like "<EU or US?>", is a REAL question, not documentation of the marker syntax.
const realBracketQuestion = openClarifications({ sections: { goal: 'ship in [NEEDS CLARIFICATION: <EU or US?>] first' } });
t('W1-01b: "<EU or US?>" is a REAL open question, not a placeholder',
  realBracketQuestion.length === 1 && realBracketQuestion[0].question === '<EU or US?>');

// W1-02a: a bounded, LINEAR scanner that counts nested "["/"]" — a question containing its own bracket
// pair ("use [EU] or US?") stays whole instead of truncating at the first "]".
const nestedBracketOpen = openClarifications({ sections: { goal: 'pick a region: [NEEDS CLARIFICATION: use [EU] or US?]' } });
t('W1-02a: a nested bracket pair inside the question stays whole',
  nestedBracketOpen.length === 1 && nestedBracketOpen[0].question === 'use [EU] or US?', JSON.stringify(nestedBracketOpen));

// W1-02b: a marker without a matching "]" never crashes. Since the Lead's review it is reported as ONE open question
// (fail-safe: a malformed marker blocks rather than silently disappearing), not ignored.
const unterminatedOpen = openClarifications({ sections: { goal: 'oops [NEEDS CLARIFICATION: no closing bracket here' } });
t('W1-02b: an unterminated marker (no matching "]") is reported once as open, not crashed on', Array.isArray(unterminatedOpen) && unterminatedOpen.length === 1 && /no closing bracket here/.test(unterminatedOpen[0].question));

// W1-02c: many repeated unterminated marker prefixes must finish FAST (linear, not the old regex's
// quadratic blow-up) — well under a second so this test never flakes.
const manyUnterminated = '[NEEDS CLARIFICATION: unterminated, no closing bracket '.repeat(20000);
const perfStart = Date.now();
const perfResult = openClarifications({ sections: { goal: manyUnterminated } });
const perfMs = Date.now() - perfStart;
t('W1-02c: 20,000 repeated unterminated marker prefixes scan in well under a second', Array.isArray(perfResult) && perfMs < 500, 'took ' + perfMs + 'ms');

// openClarifications() redacts each question string ITSELF — never relies on the source object
// having passed through writePrd()'s redaction first (a hand-written / directly-read meta fixture must
// still come out redacted).
const unredactedMeta = { prd_id: 'prd-unredacted-1', title: 'Direct fixture', sections: { goal: 'leaked key: [NEEDS CLARIFICATION: rotate ' + FAKE_SECRET + '?]' } };
const redactedOpen = openClarifications(unredactedMeta);
t('W1-03: openClarifications() redacts a secret embedded directly in the question, unconditionally',
  redactedOpen.length === 1 && !redactedOpen[0].question.includes(FAKE_SECRET) && redactedOpen[0].question.includes('***REDACTED***'));

// W1-03 (CLI): a meta.json fixture written DIRECTLY to disk (bypassing writePrd's own redaction) must
// still print redacted output through the `clarifications` CLI command.
const directMetaDir = path.join(TMP, 'forge-prd');
fs.mkdirSync(directMetaDir, { recursive: true });
fs.writeFileSync(path.join(directMetaDir, 'prd-direct-fixture.meta.json'), JSON.stringify(unredactedMeta) + '\n', 'utf8');
const rDirectFixture = runCli(['clarifications', 'prd-direct-fixture']);
t('W1-03: CLI clarifications redacts a secret from an unredacted meta fixture read directly off disk',
  rDirectFixture.status === 3 && !rDirectFixture.stdout.includes(FAKE_SECRET) && rDirectFixture.stdout.includes('***REDACTED***'));

// A malformed marker (no closing bracket) must not make a LATER valid marker disappear, and is itself
// reported as an open question (fail-safe: block rather than silently lose it).
const unterminated = openClarifications({ sections: { goal: '[NEEDS CLARIFICATION: first, never closed ... then [NEEDS CLARIFICATION: which region?]' } });
t('an unterminated marker is reported as open and does not hide a later marker', unterminated.length >= 1 && unterminated.some((c) => /first, never closed/.test(c.question)), JSON.stringify(unterminated));

// ---- W1-03 id redaction, W1-N01 documentation, W1-N04 redact before truncating ----
// every returned field is redacted, including an item id that carries a token-shaped value.
const idLeak = openClarifications({ sections: { acceptance_criteria: [{ id: FAKE_SECRET, text: '[NEEDS CLARIFICATION: which region?]' }] } });
t('W1-03: a token-shaped item id is redacted in the clarification result', idLeak.length === 1 && !JSON.stringify(idLeak).includes(FAKE_SECRET));
// W1-N01: the literal prefix written as documentation (in backticks, or escaped) is not a question.
const docPrefix = openClarifications({ sections: { architecture: 'The scanner searches for the literal prefix `[NEEDS CLARIFICATION:` in every string. An escaped \\[NEEDS CLARIFICATION: x] is shown as text.' } });
t('W1-N01: the prefix in backticks or escaped with a backslash is documentation, not an open question', docPrefix.length === 0);
const stillReal = openClarifications({ sections: { goal: 'a real, unterminated one: [NEEDS CLARIFICATION: which region' } });
t('W1-N01: a genuinely unterminated marker outside backticks is still reported', stillReal.length === 1);
// W1-N04: a token that crosses the 200-character cut of an unterminated question never leaks a fragment.
let n04ok = true;
const SK = 'sk-' + 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5'; // a 20+ char rule: a cut below 20 chars defeats it
for (let pad = 160; pad <= 200; pad++) {
  for (const tok of [FAKE_SECRET, SK]) {
    const q = openClarifications({ sections: { goal: '[NEEDS CLARIFICATION: ' + 'x'.repeat(pad) + ' ' + tok + ' never closed' } });
    const out = JSON.stringify(q);
    if (out.includes(tok.slice(0, 8))) n04ok = false;
  }
}
t('W1-N04: an unterminated question is redacted before it is cut (no token fragment at any position)', n04ok);

// Verify Boss V-01: a REAL question written inside backticks stays open (the instructions themselves show the
// marker in backticks). Only a code span that closes BEFORE the marker's closing bracket is documentation.
const inTicks = openClarifications({ sections: { goal: 'Hosting: `[NEEDS CLARIFICATION: EU or US hosting?]` before we deploy.' } });
t('V-01: a real, closed question inside backticks is still an open question', inTicks.length === 1 && inTicks[0].question === 'EU or US hosting?');
const prefixDoc = openClarifications({ sections: { goal: 'The scanner looks for `[NEEDS CLARIFICATION:` and then reads up to the matching bracket] later.' } });
t('V-01: the prefix alone in backticks (the span closes before the bracket) stays documentation', prefixDoc.length === 0);
const tickPlaceholder = openClarifications({ sections: { goal: 'Write `[NEEDS CLARIFICATION: <plain question>]` into the PRD.' } });
t('V-01: a documented placeholder inside backticks stays documentation', tickPlaceholder.length === 0);
// Verify Boss round 2, V01-a: a lone backtick whose span never closes, followed by a marker that never closes
// either, is NOT documentation — like any unterminated marker it is reported as open.
const loneTickOpen = openClarifications({ sections: { goal: 'Note `[NEEDS CLARIFICATION: EU or US? and nothing else' } });
t('V01-a: an unterminated marker after a lone backtick is still reported as open', loneTickOpen.length === 1 && /marker without a closing bracket/.test(loneTickOpen[0].question));

// =====================================================================================================
// 11) / M4 (prd-w2-discipline ac-4) — forge-prd.cjs amend <ticket_id>
// =====================================================================================================
const AMEND_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prd-amend-root-'));
fs.mkdirSync(path.join(AMEND_ROOT, 'tests'), { recursive: true });
const FIXTURE_TEST_REL = 'tests/regression-ac4.test.js';
const FIXTURE_TEST_REL_2 = 'tests/regression-ac4b.test.js';
fs.writeFileSync(path.join(AMEND_ROOT, FIXTURE_TEST_REL), '// fixture\n', 'utf8');
fs.writeFileSync(path.join(AMEND_ROOT, FIXTURE_TEST_REL_2), '// fixture 2\n', 'utf8');
const AMEND_HISTORY = path.join(TMP, 'AMEND_HISTORY.md');
const okLog = () => ({ status: 0, stdout: '', stderr: '' });
function freshPrdWithTicket(prdId) {
  const prd = { prd_id: prdId, title: 'Amend fixture', sections: { goal: 'g', acceptance_criteria: [{ id: 'ac-1', text: 'does the thing' }] } };
  writePrd(prd);
  return criteriaToTickets(prd)[0];
}
function readTicket(id) { return JSON.parse(fs.readFileSync(path.join(TMP, 'forge-tickets', id + '.json'), 'utf8')); }
function readMeta(id) { return JSON.parse(fs.readFileSync(path.join(TMP, 'forge-prd', id + '.meta.json'), 'utf8')); }
function readMd(id) { return fs.readFileSync(path.join(TMP, 'forge-prd', id + '.md'), 'utf8'); }

// --- happy path: event-first order, ticket + meta + md + history all gain the entry ---
const ticketIdA = freshPrdWithTicket('prd-amend-a');
let loggedBeforeWrite = null;
const orderLog = () => {
  const before = readTicket(ticketIdA);
  loggedBeforeWrite = !Array.isArray(before.spec_gaps) || before.spec_gaps.length === 0;
  return { status: 0 };
};
const resA = amendTicket({
  ticketId: ticketIdA, gap: 'the renderer drops the owner field', foundBy: 'rev-001',
  tests: [FIXTURE_TEST_REL], runId: 'run-amend-1', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: orderLog,
});
t('amendTicket logs ticket_updated BEFORE any write (order proven via a log seam)', loggedBeforeWrite === true);
t('amendTicket returns ok with gap-1 on the happy path', resA.ok === true && resA.gapId === 'gap-1');
const ticketA1 = readTicket(ticketIdA);
t('the ticket gains a spec_gaps entry', Array.isArray(ticketA1.spec_gaps) && ticketA1.spec_gaps.length === 1 && ticketA1.spec_gaps[0].id === 'gap-1');
const metaA1 = readMeta('prd-amend-a');
t('the PRD meta gains the same spec_gaps entry, top-level (NOT inside sections)', Array.isArray(metaA1.spec_gaps) && metaA1.spec_gaps.length === 1 && metaA1.spec_gaps[0].id === 'gap-1' && metaA1.sections.spec_gaps === undefined);
const mdA1 = readMd('prd-amend-a');
t('the rendered md has the Spec gaps found in review section naming the gap id and ticket id', mdA1.includes('## Spec gaps found in review') && mdA1.includes('gap-1') && mdA1.includes(ticketIdA));
const histA1 = fs.readFileSync(AMEND_HISTORY, 'utf8');
t('exactly one history line was appended for this amend', histA1.split('\n').filter((l) => l.includes('gap-1')).length === 1);
t('the history line matches the documented shape', histA1.includes('- Spec gap gap-1 on ' + ticketIdA + ' (prd-amend-a): the renderer drops the owner field — found by rev-001; regression test(s): tests/regression-ac4.test.js (run run-amend-1)'));

// --- a second amend on the same PRD gets gap-2; acceptance_criteria/sections stay untouched ---
const resA2 = amendTicket({ ticketId: ticketIdA, gap: 'second gap', foundBy: 'rev-002', tests: [FIXTURE_TEST_REL_2], runId: 'run-amend-2', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
t('a second amend on the same PRD gets gap-2', resA2.ok === true && resA2.gapId === 'gap-2');
const metaA2 = readMeta('prd-amend-a');
t('the PRD meta now carries both gap-1 and gap-2', metaA2.spec_gaps.length === 2 && metaA2.spec_gaps[1].id === 'gap-2');
t('acceptance_criteria is unchanged after two amends', JSON.stringify(metaA2.sections.acceptance_criteria) === JSON.stringify([{ id: 'ac-1', text: 'does the thing' }]));
t('every other section is unchanged after two amends', JSON.stringify(metaA2.sections.goal) === JSON.stringify('g'));

// --- a logging failure aborts: ticket, meta, md and history all stay byte-identical ---
const ticketIdB = freshPrdWithTicket('prd-amend-b');
const beforeTicketB = fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdB + '.json'), 'utf8');
const beforeMetaB = fs.readFileSync(path.join(TMP, 'forge-prd', 'prd-amend-b.meta.json'), 'utf8');
const beforeMdB = readMd('prd-amend-b');
const beforeHistB = fs.existsSync(AMEND_HISTORY) ? fs.readFileSync(AMEND_HISTORY, 'utf8') : null;
let threwOnLogFailure = false;
try {
  amendTicket({ ticketId: ticketIdB, gap: 'should never land', foundBy: 'rev-003', tests: [FIXTURE_TEST_REL], runId: 'run-amend-3', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: () => ({ status: 1, stderr: 'log-event boom' }) });
} catch (e) { threwOnLogFailure = /logging ticket_updated failed/i.test(e.message); }
t('a logging failure aborts amendTicket and leaves the ticket untouched', threwOnLogFailure === true && fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdB + '.json'), 'utf8') === beforeTicketB);
t('a logging failure leaves the PRD meta untouched', fs.readFileSync(path.join(TMP, 'forge-prd', 'prd-amend-b.meta.json'), 'utf8') === beforeMetaB);
t('a logging failure leaves the PRD md untouched', readMd('prd-amend-b') === beforeMdB);
t('a logging failure leaves FORGE_TASK_HISTORY untouched', (fs.existsSync(AMEND_HISTORY) ? fs.readFileSync(AMEND_HISTORY, 'utf8') : null) === beforeHistB);

// --- validation failures: each exits (throws) and writes nothing ---
let threwMissingTicket = false;
try { amendTicket({ ticketId: 'tk-does-not-exist-1', gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-x', root: AMEND_ROOT, log: okLog }); }
catch (e) { threwMissingTicket = /ticket not found/i.test(e.message); }
t('a missing ticket exits and writes nothing', threwMissingTicket === true && !fs.existsSync(path.join(TMP, 'forge-tickets', 'tk-does-not-exist-1.json')));

store.putEntity('tickets', 'tk-orphan-1', { ticket_id: 'tk-orphan-1', prd_id: 'prd-does-not-exist', title: 't', status: 'open' });
let threwMissingPrd = false;
try { amendTicket({ ticketId: 'tk-orphan-1', gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-x', root: AMEND_ROOT, log: okLog }); }
catch (e) { threwMissingPrd = /PRD not found/i.test(e.message); }
t('a missing PRD exits and writes nothing', threwMissingPrd === true && !fs.existsSync(path.join(TMP, 'forge-prd', 'prd-does-not-exist.meta.json')));

const snapTicketA = readTicket(ticketIdA), snapMetaA = readMeta('prd-amend-a'), snapMdA = readMd('prd-amend-a');
const snapHistA = fs.readFileSync(AMEND_HISTORY, 'utf8');
function assertNoChangeToA(label, cond) {
  t(label, cond === true &&
    JSON.stringify(readTicket(ticketIdA)) === JSON.stringify(snapTicketA) &&
    JSON.stringify(readMeta('prd-amend-a')) === JSON.stringify(snapMetaA) &&
    readMd('prd-amend-a') === snapMdA &&
    fs.readFileSync(AMEND_HISTORY, 'utf8') === snapHistA);
}

let threwEmptyGap = false;
try { amendTicket({ ticketId: ticketIdA, gap: '   ', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwEmptyGap = /--gap/.test(e.message); }
assertNoChangeToA('an empty --gap exits and writes nothing', threwEmptyGap);

let threwNoTest = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: [], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwNoTest = /--test/.test(e.message); }
assertNoChangeToA('no --test exits and writes nothing', threwNoTest);

let threwOutsideRoot = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: [__filename], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwOutsideRoot = /escapes the project root/.test(e.message); }
assertNoChangeToA('a --test path outside the project root exits and writes nothing', threwOutsideRoot);

let threwDotDot = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: ['../escape.js'], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwDotDot = /escapes the project root/.test(e.message); }
assertNoChangeToA('a --test path using ".." to escape the root exits and writes nothing', threwDotDot);

let threwMissingTestFile = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: ['tests/does-not-exist.test.js'], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwMissingTestFile = /does not exist/.test(e.message); }
assertNoChangeToA('a missing --test file exits and writes nothing', threwMissingTestFile);

let threwDirTest = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: ['tests'], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwDirTest = /not a file/.test(e.message); }
assertNoChangeToA('a --test path that is a directory, not a file, exits and writes nothing', threwDirTest);

let threwBadFoundBy = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: '../bad id', tests: [FIXTURE_TEST_REL], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwBadFoundBy = /--found-by/.test(e.message); }
assertNoChangeToA('an invalid --found-by id exits and writes nothing', threwBadFoundBy);

let threwBadRun = false;
try { amendTicket({ ticketId: ticketIdA, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'bad run id!', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog }); }
catch (e) { threwBadRun = /--run/.test(e.message); }
assertNoChangeToA('an invalid --run id exits and writes nothing', threwBadRun);

// --- secret redaction + 500-char cap, applied in the ticket, meta, md, logged event and history ---
const ticketIdC = freshPrdWithTicket('prd-amend-c');
let capturedEventExtra = null;
const captureLog = (runId, type, extra) => { capturedEventExtra = extra; return { status: 0 }; };
const longSecretGap = 'leaked key here: ' + FAKE_SECRET + ' ' + 'x'.repeat(600);
amendTicket({ ticketId: ticketIdC, gap: longSecretGap, foundBy: 'rev-004', tests: [FIXTURE_TEST_REL], runId: 'run-amend-4', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: captureLog });
const ticketC = readTicket(ticketIdC), metaC = readMeta('prd-amend-c'), mdC = readMd('prd-amend-c');
const histC = fs.readFileSync(AMEND_HISTORY, 'utf8');
t('a secret in the gap is redacted in the ticket', !JSON.stringify(ticketC.spec_gaps).includes(FAKE_SECRET) && JSON.stringify(ticketC.spec_gaps).includes('***REDACTED***'));
t('a secret in the gap is redacted in the PRD meta', !JSON.stringify(metaC.spec_gaps).includes(FAKE_SECRET));
t('a secret in the gap is redacted in the rendered md', !mdC.includes(FAKE_SECRET));
t('a secret in the gap is redacted in the logged ticket_updated event', capturedEventExtra != null && !JSON.stringify(capturedEventExtra).includes(FAKE_SECRET) && capturedEventExtra.spec_gap && capturedEventExtra.spec_gap.id === 'gap-1');
t('a secret in the gap is redacted in the history line', !histC.includes(FAKE_SECRET));
t('the gap text is capped at 500 characters after redaction', ticketC.spec_gaps[0].gap.length <= 500);

// --- --no-history writes no history line ---
const ticketIdD = freshPrdWithTicket('prd-amend-d');
const histBeforeD = fs.readFileSync(AMEND_HISTORY, 'utf8');
const resD = amendTicket({ ticketId: ticketIdD, gap: 'no history please', foundBy: 'rev-005', tests: [FIXTURE_TEST_REL], runId: 'run-amend-5', root: AMEND_ROOT, historyPath: AMEND_HISTORY, noHistory: true, log: okLog });
t('--no-history writes no history line', resD.ok === true && fs.readFileSync(AMEND_HISTORY, 'utf8') === histBeforeD);

// --- a spec gap carrying a clarification marker never opens a clarification ---
const ticketIdE = freshPrdWithTicket('prd-amend-e');
amendTicket({ ticketId: ticketIdE, gap: 'maybe [NEEDS CLARIFICATION: is this real?]', foundBy: 'rev-006', tests: [FIXTURE_TEST_REL], runId: 'run-amend-6', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
const metaE = readMeta('prd-amend-e');
t('a spec gap containing a clarification marker does not open a clarification', openClarifications(metaE).length === 0);

// --- rendering: no spec_gaps -> byte-identical; empty array -> no heading; inert against newlines/headings ---
t('a PRD/meta with no spec_gaps field has NO "Spec gaps found in review" heading', !renderPrd(legacyPrd).includes('Spec gaps found in review'));
t('a PRD/meta with an EMPTY spec_gaps array has NO "Spec gaps found in review" heading', !renderPrd(Object.assign({}, legacyPrd, { spec_gaps: [] })).includes('Spec gaps found in review'));
t('fc-1 (M4): an old-shape PRD with no spec_gaps still renders byte-identical to before', renderPrd(legacyPrd) === LEGACY_EXPECTED);

const trickyGapPrd = Object.assign({}, legacyPrd, {
  prd_id: 'prd-gap-inert-1',
  spec_gaps: [{ id: 'gap-1', ticket_id: 'tk-prd-gap-inert-1-1', gap: 'line one\n## Heading injection attempt\nline three', found_by: 'rev-007', tests: ['tests/x.test.js'], run_id: 'run-x', at: '2026-10-01T00:00:00.000Z' }],
});
const trickyMd = renderPrd(trickyGapPrd);
t('a gap with embedded newlines renders under its own heading', trickyMd.includes('## Spec gaps found in review'));
t('a gap containing "## Heading" text does not create a NEW heading in the rendered md', !/\n## Heading injection attempt/.test(trickyMd));
t('the gap text itself is still shown (flattened, not dropped)', trickyMd.includes('Heading injection attempt') && trickyMd.includes('line one') && trickyMd.includes('line three'));
t('the gap entry names its ticket id and found-by in the rendered md', trickyMd.includes('tk-prd-gap-inert-1-1') && trickyMd.includes('rev-007'));

// --- CLI wiring: node forge-prd.cjs amend ... ---
fs.mkdirSync(path.join(TMP, 'forge-dashboard'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'forge-dashboard', 'log-event.cjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
fs.writeFileSync(path.join(TMP, 'cli-fixture.test.js'), '// cli fixture\n', 'utf8');
const ticketIdCli = freshPrdWithTicket('prd-amend-cli-1');
const rAmendOk = runCli(['amend', ticketIdCli, '--gap', 'cli happy path gap', '--found-by', 'rev-cli', '--test', path.join(TMP, 'cli-fixture.test.js'), '--run', 'run-cli-1']);
t('CLI amend succeeds end-to-end and exits 0', rAmendOk.status === 0 && /gap-1/.test(rAmendOk.stdout) && /recorded/i.test(rAmendOk.stdout));
const rAmendMissing = runCli(['amend', 'tk-does-not-exist-xyz', '--gap', 'g', '--found-by', 'rev', '--test', path.join(TMP, 'cli-fixture.test.js'), '--run', 'run-cli-2']);
t('CLI amend exits 1 on a missing ticket', rAmendMissing.status === 1 && /ticket not found/i.test(rAmendMissing.stderr));

// =====================================================================================================
// 12) Codex findings — forge-prd.cjs amend hardening
// =====================================================================================================

// --- a labelled credential in free-text gap prose is redacted (redactValue() alone misses it;
// only redactText()'s key=value scan catches "password=..."/"client_secret=..." written in prose). ---
const ticketIdW404 = freshPrdWithTicket('prd-amend-w204');
const labelledCredGap = 'reproduce with password=FAKE_PASS_123 and client_secret=FAKE_CLIENT_SECRET_ABC';
let capturedExtraW404 = null;
amendTicket({
  ticketId: ticketIdW404, gap: labelledCredGap, foundBy: 'rev-w204', tests: [FIXTURE_TEST_REL],
  runId: 'run-w204', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
  log: (runId, type, extra) => { capturedExtraW404 = extra; return { status: 0 }; },
});
const ticketW404 = readTicket(ticketIdW404), metaW404 = readMeta('prd-amend-w204'), mdW404 = readMd('prd-amend-w204');
const histW404 = fs.readFileSync(AMEND_HISTORY, 'utf8');
t('W2-04: a labelled password= credential is redacted in the ticket', !JSON.stringify(ticketW404.spec_gaps).includes('FAKE_PASS_123'));
t('W2-04: a labelled client_secret= credential is redacted in the ticket', !JSON.stringify(ticketW404.spec_gaps).includes('FAKE_CLIENT_SECRET_ABC'));
t('W2-04: labelled credentials are redacted in the PRD meta', !JSON.stringify(metaW404.spec_gaps).includes('FAKE_PASS_123') && !JSON.stringify(metaW404.spec_gaps).includes('FAKE_CLIENT_SECRET_ABC'));
t('W2-04: labelled credentials are redacted in the rendered md', !mdW404.includes('FAKE_PASS_123') && !mdW404.includes('FAKE_CLIENT_SECRET_ABC'));
t('W2-04: labelled credentials are redacted in the logged ticket_updated event', capturedExtraW404 != null && !JSON.stringify(capturedExtraW404).includes('FAKE_PASS_123') && !JSON.stringify(capturedExtraW404).includes('FAKE_CLIENT_SECRET_ABC'));
t('W2-04: labelled credentials are redacted in the history line', !histW404.includes('FAKE_PASS_123') && !histW404.includes('FAKE_CLIENT_SECRET_ABC'));
t('W2-04: the redaction marker is actually present (proves masking happened, not accidental loss)', JSON.stringify(ticketW404.spec_gaps).includes('***REDACTED***'));

// --- W2-04 verification (re-check): an Authorization/Bearer credential in gap prose must be
// ABSENT from all five outputs (logged event, ticket, meta, md, history) — the fix lives in
// forge-store.cjs's redactText(), exercised here end-to-end through amendTicket()/sanitizeGapField(). ---
const ticketIdW404b = freshPrdWithTicket('prd-amend-w204b');
const authCredGap = 'reproduce with Authorization: Bearer FAKEBEARER123456 set on the request';
let capturedExtraW404b = null;
amendTicket({
  ticketId: ticketIdW404b, gap: authCredGap, foundBy: 'rev-w204b', tests: [FIXTURE_TEST_REL],
  runId: 'run-w204b', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
  log: (runId, type, extra) => { capturedExtraW404b = extra; return { status: 0 }; },
});
const ticketW404b = readTicket(ticketIdW404b), metaW404b = readMeta('prd-amend-w204b'), mdW404b = readMd('prd-amend-w204b');
const histW404b = fs.readFileSync(AMEND_HISTORY, 'utf8');
t('W2-04 (Authorization/Bearer): the credential is absent from the logged ticket_updated event', capturedExtraW404b != null && !JSON.stringify(capturedExtraW404b).includes('FAKEBEARER123456'));
t('W2-04 (Authorization/Bearer): the credential is absent from the ticket', !JSON.stringify(ticketW404b.spec_gaps).includes('FAKEBEARER123456'));
t('W2-04 (Authorization/Bearer): the credential is absent from the PRD meta', !JSON.stringify(metaW404b.spec_gaps).includes('FAKEBEARER123456'));
t('W2-04 (Authorization/Bearer): the credential is absent from the rendered md', !mdW404b.includes('FAKEBEARER123456'));
t('W2-04 (Authorization/Bearer): the credential is absent from the history line', !histW404b.includes('FAKEBEARER123456'));
t('W2-04 (Authorization/Bearer): the redaction marker is present (proves masking, not accidental loss)', JSON.stringify(ticketW404b.spec_gaps).includes('***REDACTED***'));
// --- Verify Boss F1: a scheme outside the old fixed list (Discord's "Bot") in all five outputs ---
const ticketIdF1 = freshPrdWithTicket('prd-amend-f1bot');
const BOT_TOKEN = ['M' + 'a'.repeat(23), 'b'.repeat(6), 'c'.repeat(27)].join('.'); // built at run time: a fake token shape, never a literal
let capturedF1 = null;
amendTicket({
  ticketId: ticketIdF1, gap: 'the bot posted with Authorization: Bot ' + BOT_TOKEN + ' in the log', foundBy: 'rev-f1', tests: [FIXTURE_TEST_REL],
  runId: 'run-f1', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
  log: (runId, type, extra) => { capturedF1 = extra; return { status: 0 }; },
});
const outsF1 = [JSON.stringify(capturedF1), JSON.stringify(readTicket(ticketIdF1).spec_gaps), JSON.stringify(readMeta('prd-amend-f1bot').spec_gaps), readMd('prd-amend-f1bot'), fs.readFileSync(AMEND_HISTORY, 'utf8')];
t('F1: an "Authorization: Bot <token>" credential is absent from event, ticket, meta, md and history', outsF1.every((s) => !s.includes(BOT_TOKEN)));
// --- Verify Boss F4: re-running an amend that already fully succeeded adds no second event or history line ---
const ticketIdF4 = freshPrdWithTicket('prd-amend-f4');
let logCallsF4 = 0;
const argsF4 = { ticketId: ticketIdF4, gap: 'F4 unique gap text for the rerun check', foundBy: 'rev-f4', tests: [FIXTURE_TEST_REL], runId: 'run-f4', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: () => { logCallsF4++; return { status: 0 }; } };
amendTicket(argsF4);
const rerunF4 = amendTicket(argsF4);
const histLinesF4 = fs.readFileSync(AMEND_HISTORY, 'utf8').split('\n').filter((l) => l.includes('F4 unique gap text')).length;
t('F4: a full re-run logs no second ticket_updated event', logCallsF4 === 1);
t('F4: a full re-run appends no second history line', histLinesF4 === 1 && rerunF4.historyAppended === false);
t('F4: a full re-run still succeeds with the same gap id', rerunF4.ok === true && rerunF4.gapId === 'gap-1');
// --- Verify Boss F5: strikethrough and bare-URL autolinks stay inert in the gap section ---
const mdF5 = renderPrd({ prd_id: 'prd-f5', title: 'f5', sections: { goal: 'g' }, spec_gaps: [{ id: 'gap-1', ticket_id: 'tk-prd-f5-1', gap: 'see ~~old~~ at https://evil.example/x and www.evil.example', found_by: 'rev', tests: ['t.js'] }] });
const gapLineF5 = mdF5.split('\n').find((l) => l.includes('gap-1')) || '';
t('F5: ~~strike~~ is escaped in the gap section', !/~~old~~/.test(gapLineF5));
t('F5: bare URLs cannot autolink (no literal "://" or "www." left in the gap line)', !/:\/\//.test(gapLineF5) && !/www\./i.test(gapLineF5));

// --- a credential-SHAPED runId/foundBy/ticketId must be REJECTED
// (exit 1 / throw, nothing written, nothing logged) rather than silently masked — the OLD behaviour below
// (masking a credential-shaped found_by while still proceeding) is now superseded; a --test PATH segment
// stays on the "sanitise, don't reject" side (it is not an identifier field). ---
const W205_CRED_ID = 'nvapi-' + 'ABCDEFGHIJ1234567890'; // a valid id shape (isValidId) that ALSO looks like a credential

// (a) a credential-shaped --found-by is REJECTED outright, nothing written, nothing logged.
const ticketIdW205a = freshPrdWithTicket('prd-amend-w205a');
let loggedW205a = false;
let threwW205aFoundBy = false, msgW205aFoundBy = '';
try {
  amendTicket({
    ticketId: ticketIdW205a, gap: 'plain gap text', foundBy: W205_CRED_ID, tests: [FIXTURE_TEST_REL],
    runId: 'run-w205a', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
    log: () => { loggedW205a = true; return { status: 0 }; },
  });
} catch (e) { threwW205aFoundBy = true; msgW205aFoundBy = e.message; }
t('W2-05: a credential-shaped --found-by is REJECTED (throws), not silently masked', threwW205aFoundBy === true && /found-by/i.test(msgW205aFoundBy));
t('W2-05: a credential-shaped --found-by never reaches the log seam (rejected before logging)', loggedW205a === false);
t('W2-05: a credential-shaped --found-by writes nothing to the ticket', JSON.parse(fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdW205a + '.json'), 'utf8')).spec_gaps === undefined);

// (b) a credential-shaped --run is REJECTED outright, nothing written, nothing logged.
const ticketIdW205b = freshPrdWithTicket('prd-amend-w205b');
let loggedW205b = false;
let threwW205bRun = false, msgW205bRun = '';
try {
  amendTicket({
    ticketId: ticketIdW205b, gap: 'plain gap text', foundBy: 'rev-w205b', tests: [FIXTURE_TEST_REL],
    runId: W205_CRED_ID, root: AMEND_ROOT, historyPath: AMEND_HISTORY,
    log: () => { loggedW205b = true; return { status: 0 }; },
  });
} catch (e) { threwW205bRun = true; msgW205bRun = e.message; }
t('W2-05: a credential-shaped --run is REJECTED (throws), not silently masked', threwW205bRun === true && /--run/.test(msgW205bRun));
t('W2-05: a credential-shaped --run never reaches the log seam (rejected before logging)', loggedW205b === false);
t('W2-05: a credential-shaped --run writes nothing to the ticket', JSON.parse(fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdW205b + '.json'), 'utf8')).spec_gaps === undefined);

// (b2) Verify Boss residual: a ticket whose prd_id is credential-shaped is REJECTED before the lock
// and before logging — the prd_id names the lock, the md path and the history line.
// Written directly (a hand-edited ticket file): store.putEntity would already redact the prd_id on write.
fs.mkdirSync(path.join(TMP, 'forge-tickets'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'forge-tickets', 'tk-cred-prd-1.json'), JSON.stringify({ ticket_id: 'tk-cred-prd-1', prd_id: W205_CRED_ID, title: 't', status: 'open' }), 'utf8');
let loggedW205p = false, threwW205p = false, msgW205p = '';
try {
  amendTicket({
    ticketId: 'tk-cred-prd-1', gap: 'plain gap text', foundBy: 'rev-w205p', tests: [FIXTURE_TEST_REL],
    runId: 'run-w205p', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
    log: () => { loggedW205p = true; return { status: 0 }; },
  });
} catch (e) { threwW205p = true; msgW205p = e.message; }
t('W2-05: a credential-shaped prd_id on the ticket is REJECTED before the lock and before logging', threwW205p === true && /prd_id/.test(msgW205p) && loggedW205p === false);

// (b3) Verify Boss round 3 note 4: an invalid-JSON ticket file must not have the parser's excerpt (which can
// quote part of a credential) echoed in the error message.
const BADJSON_TOKEN = 'ghp_' + 'A1b2' + 'C3d4'.repeat(8); // synthetic test token (FAKE): same ghp_ + 36-char shape, built at runtime
fs.writeFileSync(path.join(TMP, 'forge-tickets', 'tk-badjson-1.json'), '{"prd_id":' + BADJSON_TOKEN + '}', 'utf8');
let msgBadJson = '';
try {
  amendTicket({ ticketId: 'tk-badjson-1', gap: 'g', foundBy: 'rev-bj', tests: [FIXTURE_TEST_REL], runId: 'run-bj', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
} catch (e) { msgBadJson = e.message; }
t('note 4: an invalid-JSON ticket is refused without echoing any of its content', /not valid JSON/.test(msgBadJson) && !/ghp_|A1b2/.test(msgBadJson));
t('round 4: the invalid-JSON message says it once (no "invalid JSON: not valid JSON")', !/invalid JSON: not valid JSON/.test(msgBadJson));
// Verify Boss round 4: a ticket that exists but cannot be READ is reported as unreadable, with its real cause,
// never as "not valid JSON" (a folder where the file should be gives EISDIR on every platform).
fs.mkdirSync(path.join(TMP, 'forge-tickets', 'tk-unreadable-1.json'), { recursive: true });
let msgUnreadable = '';
try {
  amendTicket({ ticketId: 'tk-unreadable-1', gap: 'g', foundBy: 'rev-ur', tests: [FIXTURE_TEST_REL], runId: 'run-ur', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
} catch (e) { msgUnreadable = e.message; }
t('round 4: an unreadable ticket is reported as "could not be read" with its real cause, not as invalid JSON', /could not be read/.test(msgUnreadable) && /EISDIR/.test(msgUnreadable) && !/JSON/.test(msgUnreadable));

// (c) a credential-shaped ticket_id is REJECTED outright, before any read/write/log.
freshPrdWithTicket('prd-amend-w205c'); // creates the PRD; the ticket we actually amend is hand-planted below
store.putEntity('tickets', W205_CRED_ID, { ticket_id: W205_CRED_ID, prd_id: 'prd-amend-w205c', title: 't', status: 'open' });
let loggedW205c = false;
let threwW205cTicket = false, msgW205cTicket = '';
try {
  amendTicket({
    ticketId: W205_CRED_ID, gap: 'plain gap text', foundBy: 'rev-w205c', tests: [FIXTURE_TEST_REL],
    runId: 'run-w205c', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
    log: () => { loggedW205c = true; return { status: 0 }; },
  });
} catch (e) { threwW205cTicket = true; msgW205cTicket = e.message; }
t('W2-05: a credential-shaped ticket_id is REJECTED (throws), not silently masked', threwW205cTicket === true && /ticket_id/i.test(msgW205cTicket));
t('W2-05: a credential-shaped ticket_id never reaches the log seam (rejected before logging)', loggedW205c === false);
t('W2-05: a credential-shaped ticket_id write attempt leaves the planted ticket untouched', JSON.parse(fs.readFileSync(path.join(TMP, 'forge-tickets', W205_CRED_ID + '.json'), 'utf8')).spec_gaps === undefined);

// (d) a --test PATH containing a credential-shaped segment is still SANITISED (not rejected) — test paths
// are not identifier fields, so W2-05's reject rule does not apply to them (ac-4/W2-04 masking still does).
const W205_TEST_REL = 'tests/' + W205_CRED_ID + '.test.js';
fs.writeFileSync(path.join(AMEND_ROOT, W205_TEST_REL), '// w205 fixture\n', 'utf8');
const ticketIdW205d = freshPrdWithTicket('prd-amend-w205d');
let capturedExtraW205d = null;
amendTicket({
  ticketId: ticketIdW205d, gap: 'plain gap text', foundBy: 'rev-w205d', tests: [W205_TEST_REL],
  runId: 'run-w205d', root: AMEND_ROOT, historyPath: AMEND_HISTORY,
  log: (runId, type, extra) => { capturedExtraW205d = extra; return { status: 0 }; },
});
const ticketW205d = readTicket(ticketIdW205d), metaW205d = readMeta('prd-amend-w205d'), mdW205d = readMd('prd-amend-w205d');
const histW205d = fs.readFileSync(AMEND_HISTORY, 'utf8');
t('W2-05d: a credential-shaped test file name is masked (not rejected) in the logged event', capturedExtraW205d != null && !JSON.stringify(capturedExtraW205d).includes(W205_CRED_ID + '.test.js'));
t('W2-05d: a credential-shaped test file name is masked in the ticket', !JSON.stringify(ticketW205d.spec_gaps).includes(W205_CRED_ID));
t('W2-05d: a credential-shaped test file name is masked in the PRD meta', !JSON.stringify(metaW205d.spec_gaps).includes(W205_CRED_ID));
t('W2-05d: a credential-shaped test file name is masked in the rendered md', !mdW205d.includes(W205_CRED_ID));
t('W2-05d: a credential-shaped test file name is masked in the history line', !histW205d.includes(W205_CRED_ID));

// --- test-path containment is realpath-based (follows symlinks/junctions), not lexical. ---
let junctionCreateOk = true;
const W206_OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prd-outside-'));
fs.writeFileSync(path.join(W206_OUTSIDE, 'evil.test.js'), '// evil\n', 'utf8');
const W206_JUNCTION = path.join(AMEND_ROOT, 'escape-link');
try { fs.symlinkSync(W206_OUTSIDE, W206_JUNCTION, process.platform === 'win32' ? 'junction' : 'dir'); }
catch (e) { junctionCreateOk = false; }

if (junctionCreateOk) {
  const ticketIdJunction = freshPrdWithTicket('prd-amend-junction');
  let threwJunctionEscape = false;
  try {
    amendTicket({ ticketId: ticketIdJunction, gap: 'g', foundBy: 'rev', tests: ['escape-link/evil.test.js'], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
  } catch (e) { threwJunctionEscape = /escapes the project root/.test(e.message); }
  t('W2-06: a directory junction/symlink inside the root that points outside is REJECTED', threwJunctionEscape === true);
} else {
  console.log('  skip  W2-06 junction/symlink test (OS refused to create one without elevation)');
}

if (process.platform === 'win32') {
  const fixtureAbs = path.join(AMEND_ROOT, FIXTURE_TEST_REL);
  const drive = fixtureAbs.slice(0, 1);
  const flippedDrive = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + fixtureAbs.slice(1);
  const ticketIdCase = freshPrdWithTicket('prd-amend-case');
  const resCase = amendTicket({ ticketId: ticketIdCase, gap: 'g', foundBy: 'rev', tests: [flippedDrive], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
  t('W2-06: an uppercase/lowercase-flipped drive-letter spelling of a valid in-root path is accepted on win32', resCase.ok === true);
} else {
  console.log('  skip  W2-06 drive-letter-case test (not win32)');
}

const ticketIdOutside2 = freshPrdWithTicket('prd-amend-outside2');
let threwOutside2 = false;
try {
  amendTicket({ ticketId: ticketIdOutside2, gap: 'g', foundBy: 'rev', tests: [path.join(W206_OUTSIDE, 'evil.test.js')], runId: 'run-x', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
} catch (e) { threwOutside2 = /escapes the project root/.test(e.message); }
t('W2-06: a path entirely outside the root (a stand-in for "another drive") is rejected', threwOutside2 === true);

// --- atomic writes + idempotent repair after a partial (meta-write) failure. ---
const ticketIdW207 = freshPrdWithTicket('prd-amend-w207');
const metaFileW207 = path.join(TMP, 'forge-prd', 'prd-amend-w207.meta.json');
function w207DirectWrite(file, content) { const tmp = file + '.w207tmp'; fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, file); }
let w207FailMetaOnce = true;
const w207FlakyWrite = (file, content) => {
  if (file === metaFileW207 && w207FailMetaOnce) { w207FailMetaOnce = false; throw new Error('simulated disk full'); }
  w207DirectWrite(file, content);
};
let threwOnMetaWriteFailure = false;
try {
  amendTicket({ ticketId: ticketIdW207, gap: 'atomic write check', foundBy: 'rev-w207', tests: [FIXTURE_TEST_REL], runId: 'run-w207-1', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207FlakyWrite });
} catch (e) { threwOnMetaWriteFailure = /simulated disk full/.test(e.message); }
t('W2-07: an injected meta-write failure propagates (aborts amendTicket)', threwOnMetaWriteFailure === true);
const ticketW207AfterFail = readTicket(ticketIdW207);
t('W2-07: after the failed attempt the ticket already carries exactly ONE spec_gaps entry (gap-1)', Array.isArray(ticketW207AfterFail.spec_gaps) && ticketW207AfterFail.spec_gaps.length === 1 && ticketW207AfterFail.spec_gaps[0].id === 'gap-1');
let metaW207JsonValid = true, metaW207Parsed = null;
try { metaW207Parsed = JSON.parse(fs.readFileSync(metaFileW207, 'utf8')); } catch (e) { metaW207JsonValid = false; }
t('W2-07: the PRD meta is NOT truncated/corrupted by the failed write (still valid JSON)', metaW207JsonValid === true);
t('W2-07: the PRD meta has no spec_gaps yet after the failed write (original content untouched)', !metaW207Parsed || !Array.isArray(metaW207Parsed.spec_gaps) || metaW207Parsed.spec_gaps.length === 0);

const resW207Retry = amendTicket({ ticketId: ticketIdW207, gap: 'atomic write check', foundBy: 'rev-w207', tests: [FIXTURE_TEST_REL], runId: 'run-w207-2', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207FlakyWrite });
t('W2-07: the retry (same gap/found-by/tests) succeeds and reuses gap-1', resW207Retry.ok === true && resW207Retry.gapId === 'gap-1');
const ticketW207AfterRetry = readTicket(ticketIdW207);
const metaW207AfterRetry = readMeta('prd-amend-w207');
t('W2-07: after the retry the ticket STILL has exactly one spec_gaps entry (not duplicated)', ticketW207AfterRetry.spec_gaps.length === 1);
t('W2-07: after the retry the meta now has exactly one spec_gaps entry (repaired, not duplicated)', metaW207AfterRetry.spec_gaps.length === 1 && metaW207AfterRetry.spec_gaps[0].id === 'gap-1');

// --- W2-07a: a failed MD write AFTER a successful meta write must not leave a
// stale md on disk forever — a later no-op retry (ticket+meta already matched) must still re-render and
// write the md from the final meta. ---
const ticketIdW207md = freshPrdWithTicket('prd-amend-w207md');
const mdFileW207 = path.join(TMP, 'forge-prd', 'prd-amend-w207md.md');
let w207FailMdOnce = true;
const w207MdFlakyWrite = (file, content) => {
  if (file === mdFileW207 && w207FailMdOnce) { w207FailMdOnce = false; throw new Error('simulated md write failure'); }
  w207DirectWrite(file, content);
};
let threwOnMdWriteFailure = false;
try {
  amendTicket({ ticketId: ticketIdW207md, gap: 'md staleness check', foundBy: 'rev-w207md', tests: [FIXTURE_TEST_REL], runId: 'run-w207md-1', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207MdFlakyWrite });
} catch (e) { threwOnMdWriteFailure = /simulated md write failure/.test(e.message); }
t('W2-07a: an injected md-write failure propagates (aborts amendTicket)', threwOnMdWriteFailure === true);
const ticketW207mdAfterFail = readTicket(ticketIdW207md);
const metaW207mdAfterFail = readMeta('prd-amend-w207md');
t('W2-07a: after the failed md write, the ticket AND meta already carry the gap-1 entry (only md lagged behind)', ticketW207mdAfterFail.spec_gaps.length === 1 && metaW207mdAfterFail.spec_gaps.length === 1);
const mdW207mdAfterFail = fs.readFileSync(mdFileW207, 'utf8');
t('W2-07a: the md on disk is STALE right after the failure (does not yet mention the gap)', !mdW207mdAfterFail.includes('Spec gaps found in review'));

const resW207mdRetry = amendTicket({ ticketId: ticketIdW207md, gap: 'md staleness check', foundBy: 'rev-w207md', tests: [FIXTURE_TEST_REL], runId: 'run-w207md-2', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207MdFlakyWrite });
t('W2-07a: the retry succeeds as a no-op repair (ticket+meta already matched; only md needed regenerating)', resW207mdRetry.ok === true && resW207mdRetry.gapId === 'gap-1');
const mdW207mdAfterRetry = fs.readFileSync(mdFileW207, 'utf8');
t('W2-07a: the retry RE-RENDERS the md from the final meta, healing the stale file', mdW207mdAfterRetry.includes('Spec gaps found in review') && mdW207mdAfterRetry.includes('gap-1'));
// Codex stop-time review: the F4 duplicate check must not break this recovery — the failed call
// never reached the history line, so the retry still has to write it, exactly once.
const histW207md = fs.readFileSync(AMEND_HISTORY, 'utf8').split('\n').filter((l) => l.includes('md staleness check')).length;
t('W2-07a + F4: the recovery retry still writes the history line the failed call never reached (exactly once)', histW207md === 1 && resW207mdRetry.historyAppended === true);

// --- W2-07b: gap-id allocation must scan EVERY ticket of the PRD, not just the
// current ticket + meta — otherwise a ticket whose OWN write succeeded while the PRD meta's write failed
// can have its already-persisted "gap-1" collide with a DIFFERENT ticket's freshly-allocated "gap-1". ---
const prdW207b = { prd_id: 'prd-amend-w207b', title: 'Cross-ticket gap numbering', sections: { goal: 'g', acceptance_criteria: [{ id: 'ac-1', text: 'first' }, { id: 'ac-2', text: 'second' }] } };
writePrd(prdW207b);
const [ticketW207bA, ticketW207bB] = criteriaToTickets(prdW207b);
const metaFileW207b = path.join(TMP, 'forge-prd', 'prd-amend-w207b.meta.json');
let w207bFailMetaOnce = true;
const w207bFlakyWrite = (file, content) => {
  if (file === metaFileW207b && w207bFailMetaOnce) { w207bFailMetaOnce = false; throw new Error('simulated meta write failure (A)'); }
  w207DirectWrite(file, content);
};
let threwForA = false;
try {
  amendTicket({ ticketId: ticketW207bA, gap: 'gap on A', foundBy: 'rev-a', tests: [FIXTURE_TEST_REL], runId: 'run-w207b-a1', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207bFlakyWrite });
} catch (e) { threwForA = /simulated meta write failure/.test(e.message); }
t('W2-07b setup: amending A fails at the meta write as injected', threwForA === true);
const ticketW207bAAfterFail = readTicket(ticketW207bA);
t('W2-07b setup: A\'s ticket already has gap-1 even though the meta write failed', ticketW207bAAfterFail.spec_gaps.length === 1 && ticketW207bAAfterFail.spec_gaps[0].id === 'gap-1');
const metaW207bAfterAFail = readMeta('prd-amend-w207b');
t('W2-07b setup: the PRD meta has NO spec_gaps yet (A\'s meta write failed)', !Array.isArray(metaW207bAfterAFail.spec_gaps) || metaW207bAfterAFail.spec_gaps.length === 0);

const resB = amendTicket({ ticketId: ticketW207bB, gap: 'gap on B', foundBy: 'rev-b', tests: [FIXTURE_TEST_REL_2], runId: 'run-w207b-b1', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
t('W2-07b: B gets gap-2, NOT a colliding gap-1 (allocation scans every ticket of the PRD, not just meta)', resB.ok === true && resB.gapId === 'gap-2');
const ticketW207bB1 = readTicket(ticketW207bB);
t('W2-07b: B\'s ticket carries its own gap-2, correctly attributed to B', ticketW207bB1.spec_gaps.length === 1 && ticketW207bB1.spec_gaps[0].id === 'gap-2' && ticketW207bB1.spec_gaps[0].ticket_id === ticketW207bB);

const resARetry = amendTicket({ ticketId: ticketW207bA, gap: 'gap on A', foundBy: 'rev-a', tests: [FIXTURE_TEST_REL], runId: 'run-w207b-a2', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog, writeFile: w207bFlakyWrite });
t('W2-07b: retrying A repairs A\'s existing gap-1 into the meta (idempotent, not a new id)', resARetry.ok === true && resARetry.gapId === 'gap-1');
const metaW207bFinal = readMeta('prd-amend-w207b');
t('W2-07b: the final meta carries BOTH gap-1 (A) and gap-2 (B), correctly attributed', metaW207bFinal.spec_gaps.length === 2 &&
  metaW207bFinal.spec_gaps.some((g) => g.id === 'gap-1' && g.ticket_id === ticketW207bA) &&
  metaW207bFinal.spec_gaps.some((g) => g.id === 'gap-2' && g.ticket_id === ticketW207bB));

// --- W2-N01 (new finding): the duplicate-match check must include ticket_id —
// two DIFFERENT tickets with an IDENTICAL gap/found_by/tests must each get their OWN distinct, correctly
// attributed entry, not have the second one silently reuse the first ticket's id. ---
const prdWN01 = { prd_id: 'prd-amend-wn01', title: 'Duplicate gap text across tickets', sections: { goal: 'g', acceptance_criteria: [{ id: 'ac-1', text: 'first' }, { id: 'ac-2', text: 'second' }] } };
writePrd(prdWN01);
const [ticketWN01A, ticketWN01B] = criteriaToTickets(prdWN01);
const identicalGap = 'identical gap text across two tickets';
const resWN01A = amendTicket({ ticketId: ticketWN01A, gap: identicalGap, foundBy: 'rev-shared', tests: [FIXTURE_TEST_REL], runId: 'run-wn01-a', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
const resWN01B = amendTicket({ ticketId: ticketWN01B, gap: identicalGap, foundBy: 'rev-shared', tests: [FIXTURE_TEST_REL], runId: 'run-wn01-b', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
t('W2-N01: ticket A gets gap-1', resWN01A.ok === true && resWN01A.gapId === 'gap-1');
t('W2-N01: ticket B gets its OWN distinct gap-2, not a reuse of A\'s gap-1, despite identical gap/found_by/tests', resWN01B.ok === true && resWN01B.gapId === 'gap-2');
const ticketWN01A1 = readTicket(ticketWN01A), ticketWN01B1 = readTicket(ticketWN01B);
t('W2-N01: ticket A\'s own spec_gaps entry is correctly attributed to A', ticketWN01A1.spec_gaps.length === 1 && ticketWN01A1.spec_gaps[0].id === 'gap-1' && ticketWN01A1.spec_gaps[0].ticket_id === ticketWN01A);
t('W2-N01: ticket B\'s own spec_gaps entry is correctly attributed to B (not A\'s)', ticketWN01B1.spec_gaps.length === 1 && ticketWN01B1.spec_gaps[0].id === 'gap-2' && ticketWN01B1.spec_gaps[0].ticket_id === ticketWN01B);
const metaWN01 = readMeta('prd-amend-wn01');
t('W2-N01: the PRD meta carries BOTH distinct entries, each correctly attributed', metaWN01.spec_gaps.length === 2 &&
  metaWN01.spec_gaps.some((g) => g.id === 'gap-1' && g.ticket_id === ticketWN01A) &&
  metaWN01.spec_gaps.some((g) => g.id === 'gap-2' && g.ticket_id === ticketWN01B));

// --- a PRD-scoped exclusive lock across read/allocate/log/write. ---
const W208_LOCK_DIR = path.join(TMP, 'forge-runs', '.hotspot-locks');

// a held lock makes a second amend fail cleanly and write nothing
const ticketIdHeld = freshPrdWithTicket('prd-amend-lock-held');
const heldAcq = lockGuard.acquire({ hotspot: 'forge-prd-amend:prd-amend-lock-held', runId: 'other-run' }, { dir: W208_LOCK_DIR });
t('W2-08 setup: the held-lock fixture actually acquired its lock', heldAcq.ok === true);
const beforeTicketHeld = fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdHeld + '.json'), 'utf8');
const beforeMetaHeld = fs.readFileSync(path.join(TMP, 'forge-prd', 'prd-amend-lock-held.meta.json'), 'utf8');
let threwLocked = false;
try {
  amendTicket({ ticketId: ticketIdHeld, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-locked', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
} catch (e) { threwLocked = /locked/i.test(e.message); }
t('W2-08: a held lock makes a second amend fail cleanly', threwLocked === true);
t('W2-08: a held-lock amend attempt writes nothing to the ticket', fs.readFileSync(path.join(TMP, 'forge-tickets', ticketIdHeld + '.json'), 'utf8') === beforeTicketHeld);
t('W2-08: a held-lock amend attempt writes nothing to the meta', fs.readFileSync(path.join(TMP, 'forge-prd', 'prd-amend-lock-held.meta.json'), 'utf8') === beforeMetaHeld);
lockGuard.release({ hotspot: 'forge-prd-amend:prd-amend-lock-held', runId: 'other-run', token: heldAcq.token }, { dir: W208_LOCK_DIR });

// a stale lock (its holder crashed) is taken over
const ticketIdStale = freshPrdWithTicket('prd-amend-lock-stale');
const staleAcq = lockGuard.acquire({ hotspot: 'forge-prd-amend:prd-amend-lock-stale', runId: 'ghost-run' }, { dir: W208_LOCK_DIR, now: Date.now() - 100000, ttlMs: 1 });
t('W2-08 setup: the stale-lock fixture actually acquired its (backdated) lock', staleAcq.ok === true);
const resStale = amendTicket({ ticketId: ticketIdStale, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-stale', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
t('W2-08: a stale lock is taken over and the amend succeeds', resStale.ok === true);

// the lock is gone after success and after failure
const ticketIdGoneOk = freshPrdWithTicket('prd-amend-lock-gone-ok');
amendTicket({ ticketId: ticketIdGoneOk, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-gone-ok', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: okLog });
t('W2-08: the lock is released after a successful amend', lockGuard.check({ hotspot: 'forge-prd-amend:prd-amend-lock-gone-ok' }, { dir: W208_LOCK_DIR }).held === false);

const ticketIdGoneFail = freshPrdWithTicket('prd-amend-lock-gone-fail');
let threwForLockReleaseCheck = false;
try {
  amendTicket({ ticketId: ticketIdGoneFail, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-gone-fail', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: () => ({ status: 1, stderr: 'boom' }) });
} catch (e) { threwForLockReleaseCheck = true; }
t('W2-08 setup: the failing-log amend actually threw', threwForLockReleaseCheck === true);
t('W2-08: the lock is released after a failed amend too', lockGuard.check({ hotspot: 'forge-prd-amend:prd-amend-lock-gone-fail' }, { dir: W208_LOCK_DIR }).held === false);

// --- W2-08a: the log() call is bounded well below the lock TTL — a wedged child
// process must never be able to hold the PRD lock open indefinitely. Proven by injecting a log seam that
// blocks past the timeout via a synchronous busy-wait and asserting amendTicket aborts (treats the timeout
// as a logging failure) rather than hanging. Kept short (well under the real 30s bound) so this test itself
// never slows the suite down. ---
const ticketIdW208a = freshPrdWithTicket('prd-amend-w208a');
let threwOnSlowLog = false, msgSlowLog = '';
const slowLog = () => { const until = Date.now() + 50; while (Date.now() < until) { /* busy-wait, simulating a slow child */ } return { status: 1, stderr: 'simulated timeout' }; };
try {
  amendTicket({ ticketId: ticketIdW208a, gap: 'g', foundBy: 'rev', tests: [FIXTURE_TEST_REL], runId: 'run-w208a', root: AMEND_ROOT, historyPath: AMEND_HISTORY, log: slowLog });
} catch (e) { threwOnSlowLog = true; msgSlowLog = e.message; }
t('W2-08a: a logging failure (standing in for a bounded/timed-out log call) still aborts cleanly, writing nothing', threwOnSlowLog === true && /logging ticket_updated failed/i.test(msgSlowLog));
t('W2-08a: the real logEvent() spawnSync call is itself bounded (timeout option present, well below the lock TTL)', (() => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-prd.cjs'), 'utf8');
  const fnMatch = /function logEvent\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(src);
  if (!fnMatch || !/\btimeout\s*:/.test(fnMatch[0])) return false;
  // the timeout option may reference a named constant rather than an inline literal — resolve either shape.
  const timeoutRef = /timeout\s*:\s*([A-Za-z0-9_]+)/.exec(fnMatch[0])[1];
  let timeoutMs = parseInt(timeoutRef, 10);
  if (!Number.isFinite(timeoutMs)) {
    const constMatch = new RegExp('const\\s+' + timeoutRef + '\\s*=\\s*(\\d+)').exec(src);
    timeoutMs = constMatch ? parseInt(constMatch[1], 10) : NaN;
  }
  return Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs < lockGuard.DEFAULT_TTL_MS;
})());

// --- W2-08b: an expired-then-stolen lock between LOGGING and WRITING must stop the
// original holder from writing anything — simulated via the log() seam, which lets a "thief" steal the SAME
// hotspot (as if its TTL had genuinely expired) right after the original amend's log call returns. ---
const ticketIdTakeover = freshPrdWithTicket('prd-amend-takeover');
const hotspotTakeover = 'forge-prd-amend:prd-amend-takeover';
let wroteDuringTakeover = false;
const takeoverWriteFile = (file, content) => { wroteDuringTakeover = true; w207DirectWrite(file, content); };
let threwTakeover = false, msgTakeover = '';
try {
  amendTicket({
    ticketId: ticketIdTakeover, gap: 'should never land', foundBy: 'rev-takeover', tests: [FIXTURE_TEST_REL],
    runId: 'run-takeover', root: AMEND_ROOT, historyPath: AMEND_HISTORY, writeFile: takeoverWriteFile,
    log: () => {
      // simulate the original lock looking expired to a second claimant, who steals it with a brand-new token
      lockGuard.acquire({ hotspot: hotspotTakeover, runId: 'thief-run' }, { dir: W208_LOCK_DIR, now: Date.now() + 999999999 });
      return { status: 0 };
    },
  });
} catch (e) { threwTakeover = true; msgTakeover = e.message; }
t('W2-08b: a lock takeover between logging and writing is detected and the amend aborts', threwTakeover === true && /lock/i.test(msgTakeover));
t('W2-08b: nothing was written once the lock was lost (the writeFile seam was never invoked)', wroteDuringTakeover === false);
const ticketAfterTakeover = readTicket(ticketIdTakeover);
t('W2-08b: the ticket on disk is untouched after a lock takeover', ticketAfterTakeover.spec_gaps === undefined);

// --- gap rendering escapes HTML/markdown metacharacters so injected markup renders inert. ---
const w211Prd = Object.assign({}, legacyPrd, {
  prd_id: 'prd-gap-w211-1',
  spec_gaps: [{
    id: 'gap-1', ticket_id: 'tk-prd-gap-w211-1-1',
    gap: 'see <h2>Injected</h2> and [link](http://x) and **bold** and <!-- hide this -->',
    found_by: 'rev-w211', tests: ['tests/x.test.js'], run_id: 'run-x', at: '2026-10-01T00:00:00.000Z',
  }],
});
const w211Md = renderPrd(w211Prd);
t('W2-11: a raw <h2> tag does not survive as an HTML tag', !w211Md.includes('<h2>Injected</h2>') && w211Md.includes('&lt;h2&gt;Injected&lt;/h2&gt;'));
t('W2-11: a markdown link does not survive as a real link', !/\[link\]\(http:\/\/x\)/.test(w211Md) && w211Md.includes('&#91;link&#93;(http&#58;//x)')); // the '://' is broken too
t('W2-11: markdown emphasis does not survive as real emphasis', !/[^\\]\*\*bold\*\*/.test(w211Md) && w211Md.includes('\\*\\*bold\\*\\*'));
t('W2-11: an HTML comment opener does not survive as a real comment', !w211Md.includes('<!-- hide this -->') && w211Md.includes('&lt;!-- hide this --&gt;'));
t('W2-11: a PRD without spec_gaps still renders byte-identical (fc-1 preserved)', renderPrd(legacyPrd) === LEGACY_EXPECTED);

// --- escapeGapInline must ALSO escape a literal backslash (first, so it is
// never mistaken for an escape prefix the function itself just inserted) and a backtick, and the escaping
// must apply to EVERY interpolated field in renderSpecGapEntry — id and ticket_id too, not just gap text. ---
const BACKSLASH = '\\'; // one actual backslash character (built via concatenation, not hand-escaped source, to avoid off-by-one escaping mistakes in the test itself)
const BACKTICK = '`';

const w211cGap = 'see a' + BACKSLASH + 'backslash here';
const w211cPrd = Object.assign({}, legacyPrd, {
  prd_id: 'prd-gap-w211c-1',
  spec_gaps: [{ id: 'gap-1', ticket_id: 'tk-prd-gap-w211c-1-1', gap: w211cGap, found_by: 'rev-w211c', tests: ['tests/x.test.js'], run_id: 'run-x', at: '2026-10-01T00:00:00.000Z' }],
});
const w211cMd = renderPrd(w211cPrd);
const w211cExpected = 'see a' + BACKSLASH + BACKSLASH + 'backslash here';
t('W2-11c: a literal backslash in gap text is escaped (doubled), not left as a single stray backslash', w211cMd.includes(w211cExpected) && !w211cMd.includes(w211cGap));

const w211dGap = 'inline ' + BACKTICK + 'code span' + BACKTICK + ' here';
const w211dPrd = Object.assign({}, legacyPrd, {
  prd_id: 'prd-gap-w211d-1',
  spec_gaps: [{ id: 'gap-1', ticket_id: 'tk-prd-gap-w211d-1-1', gap: w211dGap, found_by: 'rev-w211d', tests: ['tests/x.test.js'], run_id: 'run-x', at: '2026-10-01T00:00:00.000Z' }],
});
const w211dMd = renderPrd(w211dPrd);
const w211dExpected = 'inline ' + BACKSLASH + BACKTICK + 'code span' + BACKSLASH + BACKTICK + ' here';
t('W2-11d: a backtick code span does not survive as a real markdown code span', w211dMd.includes(w211dExpected) && !w211dMd.includes(w211dGap));

const w211ePrd = Object.assign({}, legacyPrd, {
  prd_id: 'prd-gap-w211e-1',
  spec_gaps: [{ id: '<h2>X</h2>', ticket_id: 'tk-<script>evil</script>', gap: 'plain gap text', found_by: 'rev-w211e', tests: ['tests/x.test.js'], run_id: 'run-x', at: '2026-10-01T00:00:00.000Z' }],
});
const w211eMd = renderPrd(w211ePrd);
t('W2-11e: a hand-authored gap id containing a raw HTML tag renders inert (id is escaped too)', !w211eMd.includes('<h2>X</h2>') && w211eMd.includes('&lt;h2&gt;X&lt;/h2&gt;'));
t('W2-11e: a hand-authored ticket_id containing a raw HTML tag renders inert (ticket_id is escaped too)', !w211eMd.includes('<script>evil</script>') && w211eMd.includes('&lt;script&gt;evil&lt;/script&gt;'));
t('W2-11e: a PRD without spec_gaps still renders byte-identical (fc-1 preserved)', renderPrd(legacyPrd) === LEGACY_EXPECTED);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
