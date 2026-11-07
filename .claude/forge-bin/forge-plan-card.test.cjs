#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-plan-card.cjs (modernization WP 3.2). Every verdict is proven through the REAL CLI
 *  (spawnSync: exit code + stdout + files written), with a temp project root (FORGE_PROJECT_ROOT) and a temp config
 *  home (FORGE_CONFIG_HOME), so nothing touches this repo's .claude/forge-runs/ or the owner's FORGE_CONFIG.json.
 *  The last section runs MUTANTS of the tool (the classifier call stubbed, the question cap raised, a mode branch
 *  disabled, the dependents closure dropped): each mutant must flip a guarded outcome, which proves these tests
 *  would catch that regression. The temp folder is removed at the end. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-plan-card.cjs');
const PC = require('./forge-plan-card.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-card-test-'));
const HOME = path.join(TMP, 'home');
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
console.log('forge-plan-card tests (hermetic tmp=' + TMP + ')');

/** a temp project root with a fake log-event.cjs that records its argv, and one existing run folder */
function makeProject(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'),
    "require('fs').appendFileSync(require('path').join(__dirname, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  return root;
}
const PROJ = makeProject('proj');
fs.mkdirSync(HOME, { recursive: true });
let nfile = 0;
const writeMission = (m) => { const p = path.join(TMP, 'm' + (++nfile) + '.json'); fs.writeFileSync(p, typeof m === 'string' ? m : JSON.stringify(m)); return p; };
function run(args, opts) {
  const o = opts || {};
  return spawnSync(process.execPath, [o.cli || CLI].concat(args), { encoding: 'utf8', input: o.input,
    env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: o.root || PROJ, FORGE_CONFIG_HOME: HOME }) });
}
function card(m, extra, opts) { // -> { r, j } : the CLI result and its parsed --json output
  const r = run(['--file', writeMission(m), '--json'].concat(extra || []), opts);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* assertions below fail loudly */ }
  return { r, j };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE = {
  goal: 'Add a contact page to the demo site',
  intent: 'Visitors can reach the owner without email',
  assumptions: ['The existing stack is kept', { id: 'F2', text: 'A preview to review, not live' }],
  question: null,
  packages: [
    { id: 'A', goal: 'Build the contact page component', owns: ['src/contact.js'], route: 'build', owner: 'build-boss' },
    { id: 'B', goal: 'Write the tests for the contact page', owns: ['tests/contact.test.js'], route: 'quick', deps: ['A'] },
    { id: 'C', goal: 'Document the new page', owns: ['docs/contact.md'], route: 'quick' },
  ],
  risks: ['The form might need a backend later'],
  wont_do: ['No email sending', 'No new dependencies'],
  gates: [],
  proof: ['npm test is green', 'a screenshot of the page'],
};
const withGates = (gates, patch) => Object.assign(clone(BASE), { gates }, patch || {});
const Q1 = { text: 'Which contact route?', choices: ['A phone button', 'A form', 'Something else'], default: 'A phone button' };

// ---- 1) verdicts per plan-approval mode ----
{
  const b = card(BASE);
  t('v1 gated, no gate item: exit 0, needsApproval false, stop none, every package ready', b.r.status === 0 && !!b.j && b.j.mode === 'gated'
    && b.j.needsApproval === false && b.j.stop === 'none' && b.j.blocked.length === 0 && b.j.ready.join() === 'A,B,C');
  t('v1 the default mode comes from config (no project setting -> schema default gated)', !!b.j && b.j.modeSource === 'default');

  const push = card(withGates([{ text: 'git push origin main', wp: 'A' }]));
  t('v2 gated + declared push on A: exit 3, stop gated-packages', push.r.status === 3 && !!push.j && push.j.needsApproval === true && push.j.stop === 'gated-packages');
  t('v2 the gated package AND its dependent wait (A, B); the independent one starts (C)', !!push.j && push.j.blocked.join() === 'A,B' && push.j.ready.join() === 'C');
  t('v2 the classifier names the gate git-push and marks it recognized', !!push.j && push.j.gateItems.length === 1 && push.j.gateItems[0].gate === 'git-push'
    && push.j.gateItems[0].recognized === true && /^git-push@A:[0-9a-f]{8}$/.test(push.j.gateItems[0].key));

  const deploy = card(withGates([{ text: 'deploy the site to Vercel production', wp: 'C' }]));
  t('v3 gated + deploy gate: exit 3, gate deploy, only C waits', deploy.r.status === 3 && !!deploy.j && deploy.j.gateItems[0].gate === 'deploy' && deploy.j.blocked.join() === 'C');

  const del = card(withGates([{ text: 'clear the old build output', command: 'Remove-Item -Recurse -Force ./legacy-build', wp: 'C' }]));
  t('v4 gated + destructive delete (command): exit 3, gate destructive-delete recognized', del.r.status === 3 && !!del.j && del.j.gateItems[0].gate === 'destructive-delete' && del.j.gateItems[0].recognized);

  const out = clone(BASE); out.packages[2].owns = ['../other-project/notes.md'];
  const o = card(out);
  t('v5 gated + an owns path outside the project root: exit 3, undeclared write-outside-root found by the classifier', o.r.status === 3 && !!o.j
    && o.j.gateItems.length === 1 && o.j.gateItems[0].gate === 'write-outside-root' && o.j.gateItems[0].declared === false && o.j.gateItems[0].source === 'owns-path');
  const home = clone(BASE); home.packages[2].owns = ['~/.claude/settings.json'];
  const h = card(home);
  t('v5 a ~ path is expanded to the home folder before the isolation check (outside root -> gate)', h.r.status === 3 && !!h.j && h.j.gateItems[0].gate === 'write-outside-root');

  const und = clone(BASE); und.packages[0].goal = 'Build the page, then git push origin main';
  const u = card(und);
  t('v6 an undeclared push inside a package goal is found and counts (fail-closed)', u.r.status === 3 && !!u.j && u.j.gateItems[0].source === 'package-goal'
    && u.j.gateItems[0].declared === false && u.j.blocked.join() === 'A,B' && u.j.reasons.some((x) => /not declared/.test(x)));
  const neg = clone(BASE); neg.wont_do.push('never git push origin main');
  t('v6 wont_do is never classified: a negated push there is not a gate item', card(neg).r.status === 0);

  const unrec = card(withGates([{ text: 'lanceer de site', wp: 'C' }]));
  t('v7 a declared gate the classifier does not recognise still counts (owner-gate, recognized false)', unrec.r.status === 3 && !!unrec.j
    && unrec.j.gateItems[0].gate === null && unrec.j.gateItems[0].recognized === false && /^owner-gate@C:/.test(unrec.j.gateItems[0].key));

  const ml = card(withGates(['git push origin main']));
  t('v8 a gate item without a work package blocks every package (stop all)', ml.r.status === 3 && !!ml.j && ml.j.stop === 'all' && ml.j.blocked.join() === 'A,B,C' && ml.j.ready.length === 0);

  const al = card(BASE, ['--mode', 'always']);
  t('v9 always + no gate: exit 3, stop all (every plan waits)', al.r.status === 3 && !!al.j && al.j.mode === 'always' && al.j.modeSource === 'flag' && al.j.stop === 'all');
  const hash = al.j && al.j.cardHash;
  const okFull = card(Object.assign(clone(BASE), { approval: { card: hash } }), ['--mode', 'always']);
  const ok12 = card(Object.assign(clone(BASE), { approval: { card: String(hash).slice(0, 12) } }), ['--mode', 'always']);
  const short = card(Object.assign(clone(BASE), { approval: { card: String(hash).slice(0, 8) } }), ['--mode', 'always']);
  t('v9 always + this card approved (full hash or 12+ chars): exit 0, never asked again', okFull.r.status === 0 && ok12.r.status === 0 && !!okFull.j && okFull.j.reasons[0].includes('never asked again'));
  t('v9 an 8-char approval prefix is too short to count', short.r.status === 3);
  const changed = Object.assign(clone(BASE), { approval: { card: hash }, goal: BASE.goal + ' and a map' });
  t('v9 always + the card changed since the approval: asks again, and says so', (() => { const c = card(changed, ['--mode', 'always']); return c.r.status === 3 && c.j.reasons[0].includes('changed since'); })());

  const au = card(withGates([{ text: 'git push origin main', wp: 'A' }]), ['--mode', 'auto']);
  t('v10 auto + a gate item: exit 0, never stops, and says the gate still stops at the action itself', au.r.status === 0 && !!au.j && au.j.needsApproval === false
    && au.j.stop === 'none' && au.j.reasons.some((x) => x.includes('still stop at the action itself')) && au.j.card.includes('git-push'));
}

// ---- 2) the config key drives the mode ----
{
  const cfgRoot = makeProject('proj-config');
  const set = (v) => spawnSync(process.execPath, [path.join(__dirname, 'forge-config.cjs'), 'set', 'plan-approval', v], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: cfgRoot, FORGE_CONFIG_HOME: HOME }) });
  t('c1 forge-config knows plan-approval (enum auto|gated|always, default gated)', (() => { const s = require('./forge-config.cjs').SCHEMA.settings['plan-approval']; return !!s && s.default === 'gated' && s.allowed.join() === 'auto,gated,always'; })());
  const sa = set('always');
  const a = card(BASE, [], { root: cfgRoot });
  t('c2 /forge config set plan-approval always -> the card waits (mode always from the project setting)', sa.status === 0 && a.r.status === 3 && !!a.j && a.j.mode === 'always' && a.j.modeSource === 'project');
  set('auto');
  const b = card(withGates([{ text: 'git push origin main', wp: 'A' }]), [], { root: cfgRoot });
  t('c3 set auto -> no stop even with a gate item', b.r.status === 0 && !!b.j && b.j.mode === 'auto');
  const flag = card(BASE, ['--mode', 'gated'], { root: cfgRoot });
  t('c4 --mode overrides the setting for one run and the card says so', flag.r.status === 0 && !!flag.j && flag.j.modeSource === 'flag' && flag.j.card.includes('(per-run flag)'));
  t('c5 resolveMode never throws on an unknown mode: falls back to gated with a warning', (() => { const r = PC.resolveMode('sometimes', PROJ); return r.mode === 'gated' && r.warnings.length === 1; })());
}

// ---- 3) approval record: approved scope is never asked again ----
{
  const m = withGates([{ text: 'git push origin main', wp: 'A' }]);
  const first = card(m);
  const rec = first.j && first.j.approvalRecord;
  const again = card(Object.assign(clone(m), { approval: { gates: rec ? rec.gates : [] } }));
  t('a1 approvalRecord lists the card hash and every gate key', !!rec && rec.card === first.j.cardHash && rec.gates.length === 1);
  t('a2 gated + every gate key already approved: exit 0, the item is shown as approved, nothing asked again', again.r.status === 0 && !!again.j
    && again.j.gateItems[0].approved === true && again.j.reasons[0].includes('never asked again') && again.j.card.includes('· approved:'));
  const edited = Object.assign(withGates([{ text: 'git push --force origin main', wp: 'A' }]), { approval: { gates: rec ? rec.gates : [] } });
  t('a3 a changed gate text gets a new key, so it needs the owner again', card(edited).r.status === 3);
}

// ---- 4) the ONE-question cap and the question shape ----
{
  const two = card(Object.assign(clone(BASE), { question: undefined, questions: [Q1, Q1] }));
  t('q1 two owner questions are refused: exit 2, "ONE-question cap" named', two.r.status === 2 && /ONE-question cap: 2 owner questions/.test(two.r.stderr));
  const one = card(Object.assign(clone(BASE), { question: undefined, questions: [Q1] }));
  t('q2 one question is accepted, rendered with its choices and its default, and reported as due', one.r.status === 0 && !!one.j && one.j.questionDue === true
    && one.j.card.includes('Which contact route?') && one.j.card.includes('A) A phone button (recommended)') && one.j.card.includes('Forge uses the default: A phone button'));
  const answered = card(Object.assign(clone(BASE), { question: Object.assign({}, Q1, { answer: 'A form' }) }));
  t('q3 an answered question is not due and shows the answer', answered.r.status === 0 && answered.j.questionDue === false && answered.j.card.includes('Answer: A form'));
  t('q4 a question without a default is refused (the default is what Forge uses when unanswered)', (() => { const r = card(Object.assign(clone(BASE), { question: { text: 'x?', choices: ['a', 'b'] } })); return r.r.status === 2 && /question.default is required/.test(r.r.stderr); })());
  t('q4 a question with one choice is refused', card(Object.assign(clone(BASE), { question: { text: 'x?', choices: ['a'], default: 'a' } })).r.status === 2);
  t('q5 MAX_OWNER_QUESTIONS is exported and pinned at 1', PC.MAX_OWNER_QUESTIONS === 1);
}

// ---- 5) refusals: every problem named, nothing silently dropped ----
{
  const refuse = (patch, re) => { const m = Object.assign(clone(BASE), patch); const r = card(m); return r.r.status === 2 && !!r.j && r.j.ok === false && r.j.problems.some((p) => re.test(p)); };
  t('r1 missing goal', refuse({ goal: '' }, /goal is required/));
  t('r2 escalate is never chosen up front', refuse({ packages: [{ id: 'A', goal: 'x', owns: [], route: 'escalate' }] }, /escalate is never chosen up front/));
  t('r3 a dependency cycle', refuse({ packages: [{ id: 'A', goal: 'x', owns: [], route: 'quick', deps: ['B'] }, { id: 'B', goal: 'y', owns: [], route: 'quick', deps: ['A'] }] }, /dependency cycle: A -> B -> A/));
  t('r4 an unknown dependency', refuse({ packages: [{ id: 'A', goal: 'x', owns: [], route: 'quick', deps: ['Z'] }] }, /unknown package "Z"/));
  t('r5 an unknown gate id', refuse({ gates: [{ text: 'x', id: 'launch-rocket' }] }, /not a forge-actiongate gate id/));
  t('r6 a gate wp that is not a package', refuse({ gates: [{ text: 'git push', wp: 'Q' }] }, /"Q" is not a package id/));
  t('r7 an empty wont_do (say what the mission will NOT do)', refuse({ wont_do: [] }, /wont_do needs at least 1/));
  t('r8 an empty proof (done must be provable)', refuse({ proof: [] }, /proof needs at least 1/));
  t('r9 owns missing on a package', refuse({ packages: [{ id: 'A', goal: 'x', route: 'quick' }] }, /owns must be an array/));
  const many = card(Object.assign(clone(BASE), { goal: '', proof: [] }));
  t('r10 several problems are all listed at once', many.r.status === 2 && !!many.j && many.j.problems.length >= 2);
  const extra = card(Object.assign(clone(BASE), { colour: 'blue' }));
  t('r11 an unknown key is a visible warning, never dropped silently', extra.r.status === 0 && !!extra.j && extra.j.warnings.some((w) => w.includes('unknown key "colour"')));
  t('r12 a non-JSON mission is a usage error (exit 2)', run(['--file', writeMission('{not json')]).status === 2);
  t('r13 no --file, a bad --mode, an unknown flag, a bad --run id: exit 2', run([]).status === 2 && run(['--file', writeMission(BASE), '--mode', 'often']).status === 2
    && run(['--file', writeMission(BASE), '--bogus']).status === 2 && run(['--file', writeMission(BASE), '--run', '../x']).status === 2);
}

// ---- 6) deterministic rendering ----
{
  const f = writeMission(withGates([{ text: 'git push origin main', wp: 'A' }]));
  const a = run(['--file', f]), b = run(['--file', f]), j1 = run(['--file', f, '--json']), j2 = run(['--file', f, '--json']);
  t('d1 the Markdown card is byte-identical on a re-run', a.stdout.length > 0 && a.stdout === b.stdout && a.status === 3);
  t('d1 the JSON verdict is byte-identical on a re-run', j1.stdout.length > 0 && j1.stdout === j2.stdout);
  const m = withGates([{ text: 'git push origin main', wp: 'A' }]);
  const reordered = {}; for (const k of Object.keys(m).reverse()) reordered[k] = m[k];
  const r2 = run(['--file', writeMission(reordered)]);
  t('d2 the key order of the mission changes neither the card nor its hash', r2.stdout === a.stdout);
  const nl1 = run(['--file', f, '--lang', 'nl']), nl2 = run(['--file', f, '--lang', 'nl']);
  t('d3 the Dutch card is deterministic too and really Dutch', nl1.stdout === nl2.stdout && nl1.stdout.startsWith('# Plankaart: ') && nl1.stdout.includes('## Doet het NIET'));
  const sections = ['## Goal and real intent', '## Assumptions (auto-filled)', '## Owner question (at most one)', '## Scope', '## Work packages',
    '## Expected lanes', '## Risks', '## Will NOT do', '## Hard gates that need the owner', '## How done is proven', '## Verdict'];
  t('d4 the card holds every section: scope, packages, lanes, risks, will NOT do, gates, proof, verdict', sections.every((s) => a.stdout.includes(s)));
  t('d4 each package row shows its owner and its route with model and effort', a.stdout.includes('| A | Build the contact page component | build-boss | build (opus · medium) |'));
  t('d4 the gate note says approving the card never unlocks a gate', a.stdout.includes('Approving this card never unlocks a gate'));
  const stdin = run(['--file', '-'], { input: fs.readFileSync(f, 'utf8') }), dash = run(['-'], { input: fs.readFileSync(f, 'utf8') });
  t('d5 stdin (--file - and a bare -) gives the same card as the file', stdin.stdout === a.stdout && dash.stdout === a.stdout);
}

// ---- 7) lanes: dependency waves and one writer per file ----
{
  const m = clone(BASE); m.packages.push({ id: 'D', goal: 'Restyle the docs page', owns: ['docs/**'], route: 'quick' });
  const c = card(m);
  t('l1 waves follow the dependencies (A, C, D in wave 1; B in wave 2)', !!c.j && JSON.stringify(c.j.lanes.waves) === JSON.stringify([['A', 'C', 'D'], ['B']]));
  t('l2 C and D both own docs/: one collision, so wave 1 has 2 lanes, not 3', !!c.j && c.j.lanes.collisions.length === 1 && c.j.lanes.lanes[0] === 2 && c.j.lanes.expected === 2);
  t('l2 the card names the collision (one writer per file)', !!c.j && c.j.card.includes('One writer per file: WP C and WP D'));
}

// ---- 8) --run: the card is saved and logged ----
{
  const f = writeMission(withGates([{ text: 'git push origin main', wp: 'A' }]));
  const r = run(['--file', f, '--run', 'run-1']);
  const dir = path.join(PROJ, '.claude', 'forge-runs', 'run-1');
  const calls = fs.existsSync(path.join(PROJ, '.claude', 'forge-dashboard', 'calls.jsonl')) ? fs.readFileSync(path.join(PROJ, '.claude', 'forge-dashboard', 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  t('s1 --run writes plan-card.md (equal to the printed card) and plan-card.json', r.status === 3 && fs.existsSync(path.join(dir, 'plan-card.md'))
    && fs.readFileSync(path.join(dir, 'plan-card.md'), 'utf8') === r.stdout && JSON.parse(fs.readFileSync(path.join(dir, 'plan-card.json'), 'utf8')).needsApproval === true);
  t('s2 --run logs exactly ONE agent_note naming the card hash and the verdict', calls.length === 1 && calls[0][0] === 'run-1' && calls[0][1] === 'agent_note'
    && /plan card [0-9a-f]{12} · plan-approval gated .* needsApproval yes/.test(JSON.parse(calls[0][2]).note));
  const missing = card(BASE, ['--run', 'no-such-run']);
  t('s3 a missing run folder is a visible warning (nothing saved), never a silent pass', missing.r.status === 0 && !!missing.j && missing.j.saved === null
    && missing.j.warnings.some((w) => w.includes('does not exist')));
}

// ---- 9) the question bank: vetted questions, choices + default + domain, at most one asked ----
{
  const bankPath = path.join(__dirname, '..', 'config', 'intake', 'question-bank.json');
  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  const all = PC.bankQuestions(bank);
  const domains = new Set(['universal'].concat(Object.keys(bank.byType)));
  t('b1 the real bank validates (exit 0)', run(['validate-bank', '--bank', bankPath]).status === 0 && PC.validateBank(bank).length === 0);
  t('b2 every question has a domain, 2-4 choices and a default (en + nl)', all.length > 100 && all.every(({ domain, q }) => domains.has(domain)
    && Array.isArray(q.beginner.options) && q.beginner.options.length >= 2 && q.beginner.options.length <= 4 && !!q.beginner.assume && !!q.beginner.assume_nl));
  t('b3 the bank pins the cap at one question per mission', bank.one_question_policy && bank.one_question_policy.max_owner_questions_per_mission === 1);
  const broken = (fn) => { const b = clone(bank); fn(b); const p = path.join(TMP, 'bank-' + (++nfile) + '.json'); fs.writeFileSync(p, JSON.stringify(b)); return run(['validate-bank', '--bank', p, '--json']); };
  const noDefault = broken((b) => { delete b.byType.website[0].beginner.assume; });
  t('b4 a question without a default is invalid (exit 3, its id named)', noDefault.status === 3 && JSON.parse(noDefault.stdout).problems.some((p) => p.startsWith('website#1:') && p.includes('assume')));
  t('b5 a cap other than 1 is invalid, never applied', broken((b) => { b.one_question_policy.max_owner_questions_per_mission = 2; }).status === 3);
  t('b6 a missing policy block or a one-choice question is invalid', broken((b) => { delete b.one_question_policy; }).status === 3 && broken((b) => { b.universal[0].beginner.options = ['only one']; }).status === 3);
  const q = run(['question', '--domain', 'website', '--trigger', 'F7', '--bank', bankPath, '--json']);
  let qj = null; try { qj = JSON.parse(q.stdout); } catch { /* below */ }
  t('b7 question returns exactly ONE vetted question (an object, never a list) with choices and a default', q.status === 0 && !!qj && qj.max_owner_questions === 1
    && qj.question && !Array.isArray(qj.question) && /^website#\d+$/.test(qj.question.id) && qj.question.choices.length >= 2 && !!qj.question.default.nl);
  const unknown = run(['question', '--domain', 'rocketry', '--bank', bankPath, '--json']);
  t('b8 an unknown domain falls back to universal, with a note', unknown.status === 0 && JSON.parse(unknown.stdout).note.includes('universal questions only') && JSON.parse(unknown.stdout).question.domain === 'universal');
  t('b9 no match is an honest null (exit 0)', (() => { const r = run(['question', '--domain', 'website', '--trigger', 'F12', '--bank', bankPath, '--json']); return r.status === 0 && JSON.parse(r.stdout).question === null; })());
  t('b9 without --bank the bank is read from the project root: a root without one is exit 1, never a made-up question', run(['question', '--domain', 'website']).status === 1);
  t('b10 a picked bank question renders on the card as the ONE question', !!qj && (() => { const c = card(Object.assign(clone(BASE), { question: qj.question })); return c.r.status === 0 && c.j.card.includes(qj.question.text.en); })());
  t('b11 question without --domain is a usage error', run(['question']).status === 2);
}

// ---- 10) --request: forge-promptcheck's assumptions and its ONE question flow onto the card ----
{
  const m = clone(BASE); delete m.assumptions;
  const c = card(m, ['--request', 'de app werkt niet meer']);
  t('p1 --request merges promptcheck assumptions and takes its ONE question when the mission has none', c.r.status === 0 && !!c.j
    && c.j.question && c.j.question.id === 'F9' && c.j.question.source === 'promptcheck-ask' && c.j.card.includes('F9:'));
  const own = card(Object.assign(clone(BASE), { question: Q1 }), ['--request', 'de app werkt niet meer']);
  t('p2 the mission\'s own question is kept (one per mission) and the extra one is a visible warning', own.r.status === 0 && own.j.question.text.en === Q1.text
    && own.j.warnings.some((w) => w.includes('also proposed question F9')));
  t('p3 an empty --request is refused', card(BASE, ['--request', '  ']).r.status === 2);
}

// ---- 10b) switches: forge-anticipate's plan --json `switches` on the card (WP I.2 contract, WP 2.9b) ----
const SW = { v: 1, announcement: 'Forge uses: screenshot loop, craft lens — for a web page or UI. Waits for you: deploy, Codex review.',
  auto_enabled: [{ id: 'screenshot-loop', label: 'screenshot loop', kind: 'check' }, { id: 'craft-lens', label: 'craft lens', kind: 'check' }],
  waits_for_owner: [{ id: 'deploy', label: 'deploy', class_reason: ['production'] }, { id: 'codex-review', label: 'Codex review', class_reason: ['cost'] }],
  already_on: [], respected_off: [] };
{
  const withSw = Object.assign(clone(BASE), { switches: SW });
  const en = card(withSw), md = run(['--file', writeMission(withSw)]).stdout, base = card(BASE);
  t('sw1 a mission with switches gets the section: the announcement, then every waits_for_owner label (EN)', en.r.status === 0
    && md.includes('## Switches (anticipation)\n- ' + SW.announcement + '\n- Waits for the owner: deploy\n- Waits for the owner: Codex review\n'));
  t('sw1 switches is a known mission key: no unknown-key warning', !!en.j && !en.j.warnings.some((w) => w.includes('switches')));
  const nlSw = Object.assign(clone(BASE), { switches: Object.assign({}, SW, { announcement: 'Forge gebruikt: screenshot-lus — vanwege een webpagina of UI. Wacht op jou: uitrollen.',
    waits_for_owner: [{ id: 'deploy', label: { en: 'deploy', nl: 'uitrollen' } }, { id: 'usage-guard' }] }) });
  const nl = run(['--file', writeMission(nlSw), '--lang', 'nl']).stdout, enOfNl = run(['--file', writeMission(nlSw)]).stdout;
  t('sw2 the Dutch card has the Dutch heading and label; a {en, nl} label follows the card language; no label falls back to the id', nl.includes('## Schakelaars (vooruitgedacht)\n- Forge gebruikt:')
    && nl.includes('- Wacht op de eigenaar: uitrollen\n- Wacht op de eigenaar: usage-guard\n') && enOfNl.includes('- Waits for the owner: deploy\n'));
  t('sw3 the section sits after the hard gates and before the proof', md.indexOf('## Hard gates that need the owner') < md.indexOf('## Switches (anticipation)')
    && md.indexOf('## Switches (anticipation)') < md.indexOf('## How done is proven'));
  t('sw4 without switches there is no section (EN and NL)', !run(['--file', writeMission(BASE)]).stdout.includes('## Switches') && !run(['--file', writeMission(BASE), '--lang', 'nl']).stdout.includes('## Schakelaars'));
  t('sw4 an empty switches object (no announcement, nobody waiting) prints no section', !run(['--file', writeMission(Object.assign(clone(BASE), { switches: { v: 1, announcement: ' ', waits_for_owner: [] } }))]).stdout.includes('## Switches'));
  const changed = card(Object.assign(clone(BASE), { switches: Object.assign({}, SW, { waits_for_owner: SW.waits_for_owner.slice(0, 1) }) }));
  t('sw5 switches are part of the card hash: adding them and changing them both give a new hash', !!en.j && !!base.j && !!changed.j
    && en.j.cardHash !== base.j.cardHash && changed.j.cardHash !== en.j.cardHash);
  const canonRef = (v) => (Array.isArray(v) ? '[' + v.map(canonRef).join(',') + ']' : v !== null && typeof v === 'object'
    ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonRef(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v));
  const nm = PC.normalizeMission(BASE).mission, { approval, switches, ...old } = nm || {};
  const oldHash = require('crypto').createHash('sha256').update(canonRef(old)).digest('hex');
  t('sw5 a mission without switches keeps the pre-switches hash (canonical content minus approval), so earlier approvals stay valid', !!nm && switches === null
    && PC.cardHash(nm) === oldHash && !!base.j && base.j.cardHash === oldHash);
  const bad = card(Object.assign(clone(BASE), { switches: 'turn everything on' }));
  t('sw6 a non-object switches is a visible warning, never on the card and never in the hash', bad.r.status === 0 && !!bad.j && bad.j.warnings.some((w) => w.includes('switches must be the object'))
    && !bad.j.card.includes('## Switches') && !!base.j && bad.j.cardHash === base.j.cardHash);
  const ant = spawnSync(process.execPath, [path.join(__dirname, 'forge-anticipate.cjs'), 'plan', '--text', 'build a landing page for a bakery and deploy it to production', '--json'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: PROJ, FORGE_CONFIG_HOME: HOME }) });
  let real = null; try { real = JSON.parse(ant.stdout).switches; } catch { /* asserted below */ }
  const rc = real ? run(['--file', writeMission(Object.assign(clone(BASE), { switches: real }))]).stdout : '';
  t('sw7 the REAL forge-anticipate plan --json `switches` drops in unchanged: its announcement and every gated label are on the card', ant.status === 0 && !!real
    && real.waits_for_owner.length >= 1 && rc.includes('- ' + real.announcement + '\n') && real.waits_for_owner.every((w) => rc.includes('- Waits for the owner: ' + w.label + '\n')));
}

// ---- 11) mutation checks: each mutant must flip a guarded outcome ----
{
  const src = fs.readFileSync(CLI, 'utf8');
  const lines = src.replace(/\n$/, '').split('\n').length;
  t('m0 the tool stays under 500 lines (' + lines + ') and the classifier call sits on ONE marked line', lines < 500 && src.split('PLAN-CARD-CLASSIFIER-CALL').length === 2);
  const abs = (f) => JSON.stringify(path.join(__dirname, f));
  const mutant = (name, find, replace) => {
    const n = src.split(find).length - 1;
    const body = src.split(find).join(replace).replace("require('./forge-actiongate.cjs')", 'require(' + abs('forge-actiongate.cjs') + ')')
      .replace("require('./forge-config.cjs')", 'require(' + abs('forge-config.cjs') + ')').replace("require('./forge-promptcheck.cjs')", 'require(' + abs('forge-promptcheck.cjs') + ')');
    const p = path.join(TMP, 'mutant-' + name + '.cjs');
    fs.writeFileSync(p, body);
    return { n, cli: p };
  };
  const status = (cli, m, extra) => run(['--file', writeMission(m), '--json'].concat(extra || []), { cli }).status;
  const undeclared = clone(BASE); undeclared.packages[0].goal = 'Build the page, then git push origin main';
  const outside = clone(BASE); outside.packages[2].owns = ['../other-project/notes.md'];
  const m1 = mutant('no-classifier', 'return actiongate.classify(input, { projectRoot: root });', "return { gate: false, id: null, class: null, reason: null, matched: [] };");
  t('m1 classifier call removed -> the undeclared push and the outside-root path slip through (mutant killed)', m1.n === 1
    && status(CLI, undeclared) === 3 && status(m1.cli, undeclared) === 0 && status(CLI, outside) === 3 && status(m1.cli, outside) === 0);
  const m2 = mutant('cap-2', 'const MAX_OWNER_QUESTIONS = 1;', 'const MAX_OWNER_QUESTIONS = 2;');
  const twoQ = Object.assign(clone(BASE), { question: undefined, questions: [Q1, Q1] });
  t('m2 the question cap raised to 2 -> two questions are accepted (mutant killed)', m2.n === 1 && status(CLI, twoQ) === 2 && status(m2.cli, twoQ) !== 2);
  const m3 = mutant('no-always', "else if (mode === 'always') {", "else if (mode === 'always-disabled') {");
  t('m3 the always branch disabled -> always stops nothing (mutant killed)', m3.n === 1 && status(CLI, BASE, ['--mode', 'always']) === 3 && status(m3.cli, BASE, ['--mode', 'always']) === 0);
  const m4 = mutant('no-auto', "if (mode === 'auto') {", "if (mode === 'auto-disabled') {");
  const gated = withGates([{ text: 'git push origin main', wp: 'A' }]);
  t('m4 the auto branch disabled -> auto stops on a gate (mutant killed)', m4.n === 1 && status(CLI, gated, ['--mode', 'auto']) === 0 && status(m4.cli, gated, ['--mode', 'auto']) === 3);
  const m5 = mutant('no-dependents', 'dependents(mission.packages, open.map((it) => it.wp))', 'open.map((it) => it.wp)');
  const blocked = (cli) => { const r = run(['--file', writeMission(gated), '--json'], { cli }); try { return JSON.parse(r.stdout).blocked.join(); } catch { return null; } };
  t('m5 the dependents closure dropped -> B (depends on A) would start before the gate is approved (mutant killed)', m5.n === 1 && blocked(CLI) === 'A,B' && blocked(m5.cli) === 'A');
  const m6 = mutant('switches-unhashed', 'if (content.switches == null) delete content.switches;', 'delete content.switches;');
  const hashOf = (cli, m) => { const r = run(['--file', writeMission(m), '--json'], { cli }); try { return JSON.parse(r.stdout).cardHash; } catch { return null; } };
  const withSw = Object.assign(clone(BASE), { switches: SW });
  t('m6 switches left out of the hash -> a card with switches hashes like one without (mutant killed)', m6.n === 1 && !!hashOf(CLI, withSw)
    && hashOf(CLI, withSw) !== hashOf(CLI, BASE) && hashOf(m6.cli, withSw) === hashOf(m6.cli, BASE));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort: the OS cleans its temp folder */ }
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
