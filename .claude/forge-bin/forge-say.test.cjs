'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-say.test.cjs — WP A1. Standalone, own TEMP project root, cleaned up at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const say = require('./forge-say.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
function eq(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function w(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-say-'));
const RUN = 'forge-test-run-1';
w(root, '.claude/config/agents/agent-registry.json', JSON.stringify({
  agents: { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' }, 'review-boss': { name: 'Review Boss' } },
  specialistAgents: { _doc: 'ignored', 'verify-boss': { name: 'Verify Boss' } },
}));
fs.mkdirSync(path.join(root, '.claude', 'forge-runs', RUN), { recursive: true });
const chat = path.join(root, '.claude', 'forge-runs', RUN, say.CHAT_FILE);

function run(args) {
  const out = [], err = [];
  const code = say.main(args.concat(['--root', root]), { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err };
}

t('append writes one JSON line with the contract fields', () => {
  const r = run([RUN, '--from', 'build-boss', '--to', 'Test Boss', '--wp', 'A1', '--kind', 'handoff', 'tests ready for src/x.cjs']);
  eq(r.code, 0);
  const lines = fs.readFileSync(chat, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(lines.length, 1);
  const o = lines[0];
  eq(Object.keys(o), ['ts', 'run_id', 'from', 'to', 'wp_id', 'kind', 'text', 'via']);
  eq([o.run_id, o.from, o.to, o.wp_id, o.kind, o.text, o.via], [RUN, 'Build Boss', 'Test Boss', 'A1', 'handoff', 'tests ready for src/x.cjs', 'direct']);
  ok(!Number.isNaN(Date.parse(o.ts)), 'ts is an ISO date');
  eq(r.out[0], JSON.stringify(o));
});

t('lead is always valid and specialists are valid names', () => {
  eq(run([RUN, '--from', 'Verify Boss', '--to', 'lead', '--wp', 'A2', '--kind', 'blocker', 'need owner key']).code, 0);
});

t('relayed message carries via:"lead"', () => {
  const r = run([RUN, '--from', 'review-boss', '--to', 'build-boss', '--wp', 'A1', '--kind', 'question', '--via', 'lead', 'why is x mutable?']);
  eq(r.code, 0);
  eq(JSON.parse(r.out[0]).via, 'lead');
});

t('list prints the channel in order and filters by wp', () => {
  const all = run([RUN, '--list', '--json']);
  eq(all.code, 0);
  eq(JSON.parse(all.out[0]).map((o) => o.from), ['Build Boss', 'Verify Boss', 'Review Boss']);
  const a2 = run([RUN, '--list', '--wp', 'A2', '--json']);
  eq(JSON.parse(a2.out[0]).map((o) => o.wp_id), ['A2']);
  const human = run([RUN, '--list']);
  ok(/\[Build Boss -> Test Boss\] tests ready/.test(human.out[0]), 'human line shape');
  ok(/via=lead/.test(human.out[2]), 'relay marked');
});

t('unknown sender or receiver is refused, nothing written', () => {
  const before = fs.readFileSync(chat, 'utf8');
  const r1 = run([RUN, '--from', 'Ghost Boss', '--to', 'lead', '--wp', 'A1', 'hi']);
  const r2 = run([RUN, '--from', 'lead', '--to', 'nobody', '--wp', 'A1', 'hi']);
  eq([r1.code, r2.code], [1, 1]);
  ok(/not an agent-registry.json name/.test(r1.err[0]));
  eq(fs.readFileSync(chat, 'utf8'), before);
});

t('empty text, bad kind, missing wp are refused', () => {
  eq(run([RUN, '--from', 'lead', '--to', 'build-boss', '--wp', 'A1', '   ']).code, 1);
  eq(run([RUN, '--from', 'lead', '--to', 'build-boss', '--wp', 'A1', '--kind', 'shout', 'x']).code, 1);
  eq(run([RUN, '--from', 'lead', '--to', 'build-boss', 'x']).code, 1);
});

t('secrets are scrubbed before the line reaches disk', () => {
  const key = 'sk-' + 'A'.repeat(30);
  const gh = 'ghp_' + 'b'.repeat(30);
  const r = run([RUN, '--from', 'lead', '--to', 'build-boss', '--wp', 'A1', 'use ' + key + ' and ' + gh + ' and password=hunter2']);
  eq(r.code, 0);
  const disk = fs.readFileSync(chat, 'utf8');
  ok(!disk.includes(key) && !disk.includes(gh) && !disk.includes('hunter2'), 'no secret on disk');
  ok(/REDACTED/.test(JSON.parse(r.out[0]).text), 'marker present');
});

t('missing run folder is refused with exit 2 and creates nothing', () => {
  const r = run(['forge-no-such-run', '--from', 'lead', '--to', 'build-boss', '--wp', 'A1', 'x']);
  eq(r.code, 2);
  ok(!fs.existsSync(path.join(root, '.claude', 'forge-runs', 'forge-no-such-run')));
});

t('invalid run id is refused', () => {
  eq(run(['../escape', '--from', 'lead', '--to', 'build-boss', '--wp', 'A1', 'x']).code, 1);
});

t('--event is a visible no-op when log-event.cjs is absent or does not register agent_message (chat line still written)', () => {
  const r = run([RUN, '--from', 'lead', '--to', 'test-boss', '--wp', 'A1', '--event', 'go']);
  eq(r.code, 0);
  ok(r.out.some((l) => /NOTICE --event: "agent_message" is not registered/.test(l)), 'notice printed');
  ok(!fs.existsSync(path.join(root, '.claude', 'forge-runs', RUN, 'events.jsonl')), 'no event written');
});

t('FB-MISC-2-F9: --event with the real log-event.cjs writes an agent_message event (it is registered)', () => {
  const real = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  w(root, '.claude/forge-dashboard/log-event.cjs', fs.readFileSync(real, 'utf8'));
  w(root, '.claude/forge-runs/' + RUN + '/run.json', JSON.stringify({ run_id: RUN }));
  try {
    const r = run([RUN, '--from', 'lead', '--to', 'test-boss', '--wp', 'A1', '--event', 'mirror me']);
    eq(r.code, 0);
    ok(!r.out.some((l) => /not registered/.test(l)), 'no "unregistered" notice: ' + r.out.join(' | ') + r.err.join(' | '));
    const ev = fs.readFileSync(path.join(root, '.claude', 'forge-runs', RUN, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(ev.some((e) => (e.event_type || e.type) === 'agent_message' && JSON.stringify(e).includes('mirror me')), 'agent_message event on disk');
  } finally { fs.rmSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true, force: true }); }
});

t('FB-MISC-2-F9: --event that log-event.cjs refuses returns 1 and says so (the chat line is still written)', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-say-refuse-'));
  try {
    w(root2, '.claude/config/agents/agent-registry.json', JSON.stringify({ agents: { 'test-boss': { name: 'Test Boss' } } }));
    fs.mkdirSync(path.join(root2, '.claude', 'forge-runs', RUN), { recursive: true });
    w(root2, '.claude/forge-dashboard/log-event.cjs', "module.exports = { KNOWN_EVENT_TYPES: new Set(['agent_message']) };\nif (require.main === module) { console.error('refused by the stub'); process.exit(2); }\n");
    const out = [], err = [];
    const code = say.main([RUN, '--from', 'lead', '--to', 'test-boss', '--wp', 'A1', '--event', 'x', '--root', root2], { out: (s) => out.push(s), err: (s) => err.push(s) });
    eq(code, 1);
    ok(err.some((l) => /refused by log-event\.cjs \(exit 2\)/.test(l)), err.join(' | '));
    ok(fs.readFileSync(path.join(root2, '.claude', 'forge-runs', RUN, say.CHAT_FILE), 'utf8').includes('"x"'), 'chat line written');
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});

t('CLI process: exit code and printed line', () => {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'forge-say.cjs'), RUN, '--root', root, '--from', 'test-boss', '--to', 'lead', '--wp', 'A1', 'cli works'], { encoding: 'utf8', timeout: 30000 });
  eq(p.status, 0);
  eq(JSON.parse(p.stdout.trim()).text, 'cli works');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
