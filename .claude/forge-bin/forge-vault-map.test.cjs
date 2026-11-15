'use strict';
// WP-TMP-LEAK: this suite and its child processes make their temp dirs inside one per-run folder, removed at exit.
const TMP_RUN = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), require('path').basename(__filename, '.test.cjs') + '-run-'));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = TMP_RUN;
process.on('exit', () => { try { require('fs').rmSync(TMP_RUN, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { process.stderr.write('temp cleanup failed: ' + TMP_RUN + ' (' + e.code + ')\n'); } });
// forge-vault-map.test.cjs — node:test for forge-vault-map.cjs (vault map + mindmap + recall + add-note).
// Every test builds its own throwaway fixture project under os.tmpdir() and removes it file by file afterwards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAP = require('./forge-vault-map.cjs');

// Count results so the doctor's tally check sees a '<n> passed, <m> failed' line (node:test's own summary reads as 0/0).
let pass = 0; let fail = 0;
function T(name, fn) { test(name, (ctx) => { try { const r = fn(ctx); pass++; return r; } catch (e) { fail++; throw e; } }); }
process.on('exit', () => { console.log(pass + ' passed, ' + fail + ' failed (forge-vault-map)'); });

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlZmFrZTEyMzQ1Njc4OTA';
const FAKE_B64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz1234567890ABCDEFabcdefZZ';

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmTree(p); else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvmap-'));
  write(root, 'CLAUDE.md', '# CLAUDE.md\n\n## Honesty (REQUIRED)\nNever claim a check ran if it did not.\n\n## Scratch-discipline (HARD)\nUse _scratch/.\n');
  write(root, '.claude/agents/build-boss.md', '---\nname: build-boss\ndescription: "Builds features."\nmodel: opus\neffort: medium\nskills:\n  - forge-conduct\n  - test-driven-development\n---\nBody\n');
  write(root, '.claude/agents/scribe.md', '---\nname: scribe\ndescription: Records owner asks.\nmodel: sonnet\neffort: low\n---\nBody\n');
  write(root, '.claude/config/agents/agent-registry.json', {
    agents: { 'build-boss': { name: 'Build Boss', role: 'Builder', responsibilities: 'Builds things.' } },
    specialistAgents: { _doc: 'x', scribe: { name: 'Scribe', role: 'Notulist' } },
  });
  write(root, '.claude/config/agents/agent-skill-map.json', { agents: { 'build-boss': ['forge-conduct', 'test-driven-development', 'not-a-real-skill'], scribe: ['forge-conduct'] } });
  write(root, '.claude/FORGE_MODEL_ROUTING.json', {
    routes: { build: { model: 'opus', effort: 'medium', when: 'normal feature' }, quick: { model: 'sonnet', effort: 'low', when: 'small' } },
    agentDefaults: { _note: 'x', 'build-boss': 'build', scribe: 'quick' },
  });
  write(root, '.claude/skills/forge-conduct/SKILL.md', '---\nname: forge-conduct\ndescription: House rules for every agent.\n---\n# x\n');
  write(root, '.claude/skills/forge-website/SKILL.md', '---\nname: forge-website\ndescription: Playbook for websites: responsive, SEO.\n---\n# x\n');
  write(root, '.claude/skills/test-driven-development/SKILL.md', '---\nname: test-driven-development\ndescription: >\n  Use when building a feature,\n  before code.\n---\n# x\n');
  write(root, '.claude/config/skills/global-skills.json', { bundles: { website: [{ skill: 'frontend-design', kind: 'ecc/plugin' }, { skill: 'forge-website', kind: 'forge-playbook' }] } });
  write(root, '.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json', { settings: { 'usage-guard': { type: 'bool', default: true, group: 'core', desc: { nl: 'Pauzeert Forge.', en: 'Pauses Forge.' } } } });
  write(root, '.claude/config/orchestration/FORGE_HARD_RULES.json', { rules: [{ id: 'memory-read', rule: 'Read memory first.', severity: 'block' }], orchestration_hard_rules: [{ id: 'one-writer', rule: 'One writer per hotspot.' }] });
  write(root, '.claude/config/orchestration/FORGE_STANDING_RULES.json', { rules: [{ id: 'honesty-core', text: 'Never fake a check.', topic: 'honesty' }] });
  write(root, '.claude/config/orchestration/hard-gates.json', { gates: [{ id: 'deploy', class: 'irreversible', reason: 'Deploying is irreversible.' }] });
  write(root, '.claude/settings.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"' }] }] } });
  write(root, '.claude/forge-runs/forge-2026-11-01-demo/run.json', { run_id: 'forge-2026-11-01-demo', request: 'Build the zebrafish dashboard ' + FAKE_JWT, status: 'done', project_type: 'website' });
  write(root, '.claude/forge-runs/forge-2026-11-02-noj/events.jsonl', '');
  write(root, '.claude/forge-runs/_toollog/x.txt', 'ignored');
  write(root, '.claude/agent-memory/build-boss/MEMORY.md', '# Build Boss Memory\n\n- 2026-11-09 lesson: quokka migrations need a dry run. token ' + FAKE_B64 + '\n');
  write(root, '.claude/forge-vault/runs/forge-2026-11-01-demo.md', '---\ntitle: demo\n---\n# demo run note\n');
  write(root, '.claude/forge-vault/Home.md', '---\ntitle: Forge Vault\n---\n# Forge Vault\n');
  return root;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function snapshot(dir) {
  const o = {};
  for (const f of walk(dir).sort()) o[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
  return o;
}

T('generate is idempotent: second run writes nothing and output is byte-identical', () => {
  const root = fixture();
  try {
    const r1 = MAP.generate({ root, date: '2026-11-10' });
    assert.ok(r1.written > 0, 'first run writes notes');
    const vault = path.join(root, '.claude', 'forge-vault');
    const s1 = snapshot(vault);
    const r2 = MAP.generate({ root, date: '2026-11-10' });
    assert.strictEqual(r2.written, 0, 'second run must write 0 files');
    assert.deepStrictEqual(snapshot(vault), s1);
    // existing vault files outside map/ are untouched
    assert.strictEqual(fs.readFileSync(path.join(vault, 'Home.md'), 'utf8'), '---\ntitle: Forge Vault\n---\n# Forge Vault\n');
  } finally { rmTree(root); }
});

T('no dead wikilinks and canvas references resolve', () => {
  const root = fixture();
  try {
    MAP.generate({ root, date: '2026-11-10' });
    const vault = path.join(root, '.claude', 'forge-vault');
    const dead = MAP.findDeadLinks(vault);
    assert.deepStrictEqual(dead, []);
    // independent re-check: every [[target]] in map/ resolves to a .md under the vault
    let links = 0;
    for (const f of walk(path.join(vault, 'map')).filter((x) => x.endsWith('.md'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
        links++;
        assert.ok(fs.existsSync(path.join(vault, m[1] + '.md')), `dead link ${m[1]} in ${f}`);
      }
    }
    assert.ok(links > 10, 'map notes are linked');
    const canvas = JSON.parse(fs.readFileSync(path.join(vault, 'map', 'Forge-Mindmap.canvas'), 'utf8'));
    const ids = new Set(canvas.nodes.map((n) => n.id));
    assert.strictEqual(ids.size, canvas.nodes.length, 'unique node ids');
    for (const e of canvas.edges) { assert.ok(ids.has(e.fromNode) && ids.has(e.toNode), 'edge endpoints exist'); }
    for (const n of canvas.nodes.filter((x) => x.type === 'file')) assert.ok(fs.existsSync(path.join(vault, n.file)), n.file);
    const labels = canvas.nodes.filter((n) => n.type === 'group').map((n) => n.label);
    for (const g of ['Bosses', 'Skills', 'Hooks/Gates', 'Playbooks', 'Runs', 'Rules', 'Owner-poorten']) assert.ok(labels.some((l) => l.startsWith(g)), 'group ' + g);
    assert.ok(canvas.edges.some((e) => e.label === 'skill'), 'agent->skill edge');
    assert.ok(canvas.edges.some((e) => e.label === 'route'), 'agent->route edge');
    // the agent with a missing skill does not get a link to an invented note
    assert.ok(!fs.existsSync(path.join(vault, 'map', 'skills', 'not-a-real-skill.md')));
  } finally { rmTree(root); }
});

T('no secret-like pattern in any generated output', () => {
  const root = fixture();
  try {
    MAP.generate({ root, date: '2026-11-10' });
    MAP.addNote({ root, title: 'Leak test', kind: 'lesson', body: 'oops ' + FAKE_JWT, date: '2026-11-10' });
    const vault = path.join(root, '.claude', 'forge-vault', 'map');
    for (const f of walk(vault)) {
      const t = fs.readFileSync(f, 'utf8');
      assert.ok(!t.includes(FAKE_JWT) && !t.includes(FAKE_B64), 'secret leaked in ' + f);
      assert.deepStrictEqual(MAP.findSecrets(t), [], 'secret pattern in ' + f);
    }
    // the run and memory notes are still written, with a redaction marker (forge-store's ***REDACTED*** or the local [REDACTED])
    assert.match(fs.readFileSync(path.join(vault, 'memory', 'build-boss.md'), 'utf8'), /\[REDACTED\]|\*\*\*REDACTED\*\*\*/);
  } finally { rmTree(root); }
});

T('recall finds a known term, with path, excerpt and backlinks', () => {
  const root = fixture();
  try {
    MAP.generate({ root, date: '2026-11-10' });
    const hits = MAP.recall({ root, query: 'quokka' });
    assert.ok(hits.length >= 1, 'recall finds the memory lesson');
    assert.strictEqual(hits[0].path, 'map/memory/build-boss.md');
    assert.match(hits[0].excerpt, /quokka/i);
    assert.ok(hits[0].backlinks.includes('map/agents/build-boss'), 'agent note links to its memory note');
    const z = MAP.recall({ root, query: 'zebrafish' });
    assert.ok(z.some((h) => h.path === 'map/runs/forge-2026-11-01-demo.md'));
    assert.deepStrictEqual(MAP.recall({ root, query: 'nonexistentterm-xyz' }), []);
  } finally { rmTree(root); }
});

T('add-note writes a linked lesson that recall then finds; rerun is a no-op; unknown links dropped', () => {
  const root = fixture();
  try {
    MAP.generate({ root, date: '2026-11-10' });
    const r = MAP.addNote({ root, title: 'Platypus lesson', kind: 'lesson', body: 'Always dry-run platypus migrations.', links: ['map/agents/build-boss', 'map/agents/ghost'], date: '2026-11-10' });
    assert.strictEqual(r.written, true);
    assert.deepStrictEqual(r.droppedLinks, ['map/agents/ghost']);
    const again = MAP.addNote({ root, title: 'Platypus lesson', kind: 'lesson', body: 'Always dry-run platypus migrations.', links: ['map/agents/build-boss', 'map/agents/ghost'], date: '2026-11-10' });
    assert.strictEqual(again.written, false);
    const hits = MAP.recall({ root, query: 'platypus' });
    assert.strictEqual(hits[0].path, r.path);
    // regenerating keeps the added note and indexes it
    MAP.generate({ root, date: '2026-11-10' });
    assert.ok(fs.existsSync(path.join(root, '.claude', 'forge-vault', r.path)));
    assert.match(fs.readFileSync(path.join(root, '.claude', 'forge-vault', 'map', 'Map-Home.md'), 'utf8'), /Platypus lesson/);
    assert.deepStrictEqual(MAP.findDeadLinks(path.join(root, '.claude', 'forge-vault')), []);
  } finally { rmTree(root); }
});

T('scrub masks URL-embedded passwords and labelled secrets the way forge-store.redactText does; findSecrets sees them (FB-BRAIN-F5)', () => {
  const pw = 'hunter' + '2xyz';
  const raw = 'lesson: connect with postgres://admin:' + pw + '@db.example.com/app before the migration';
  const out = MAP.scrub(raw);
  assert.ok(!out.includes(pw), 'password survived scrub: ' + out);
  assert.match(out, /postgres:\/\/admin:/);
  assert.ok(!MAP.scrub('db password=' + pw).includes(pw));
  assert.ok(MAP.findSecrets(raw).length > 0, 'findSecrets missed the URL password');
  assert.deepStrictEqual(MAP.findSecrets(out), [], 'scrubbed text still reads as a secret');
  assert.strictEqual(MAP.scrub('Always dry-run platypus migrations.'), 'Always dry-run platypus migrations.');
});

T('add-note without --date uses today, and a second note with the same title never overwrites the first (FB-BRAIN-F6)', () => {
  const root = fixture();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const a = MAP.addNote({ root, title: 'Gate lesson', body: 'Body A' });
    assert.strictEqual(a.path, `map/notes/${today}-gate-lesson.md`);
    const b = MAP.addNote({ root, title: 'Gate lesson', body: 'Body B' });
    assert.strictEqual(b.written, true);
    assert.notStrictEqual(b.path, a.path);
    const vault = path.join(root, '.claude', 'forge-vault');
    assert.match(fs.readFileSync(path.join(vault, a.path), 'utf8'), /Body A/);
    assert.match(fs.readFileSync(path.join(vault, b.path), 'utf8'), /Body B/);
    const again = MAP.addNote({ root, title: 'Gate lesson', body: 'Body B' });
    assert.strictEqual(again.written, false);
    assert.strictEqual(again.path, b.path);
  } finally { rmTree(root); }
});

T('stale generated notes are removed one by one, hand files kept', () => {
  const root = fixture();
  try {
    MAP.generate({ root, date: '2026-11-10' });
    const vault = path.join(root, '.claude', 'forge-vault', 'map');
    write(vault, 'hand-note.md', '# mine\n');
    fs.unlinkSync(path.join(root, '.claude', 'agents', 'scribe.md'));
    const reg = JSON.parse(fs.readFileSync(path.join(root, '.claude/config/agents/agent-registry.json'), 'utf8'));
    delete reg.specialistAgents.scribe;
    write(root, '.claude/config/agents/agent-registry.json', reg);
    const r = MAP.generate({ root, date: '2026-11-10' });
    assert.ok(r.removed >= 1);
    assert.ok(!fs.existsSync(path.join(vault, 'agents', 'scribe.md')));
    assert.ok(fs.existsSync(path.join(vault, 'hand-note.md')));
    assert.deepStrictEqual(MAP.findDeadLinks(path.join(root, '.claude', 'forge-vault')), []);
  } finally { rmTree(root); }
});

// 2026-11-13 final verify: forge-store.redactText cuts text at 50000 chars, so findSecrets flagged EVERY file longer
// than that (the 85 KB Brain-Mindmap.canvas) as secret. Long plain text is clean; a secret past the cut is still seen.
T('findSecrets: long plain text is not a secret, and a secret after char 50000 is still found', () => {
  const plain = 'plain words about a mind map. '.repeat(3000); // about 90000 chars
  assert.ok(plain.length > 60000);
  assert.deepStrictEqual(MAP.findSecrets(plain), [], 'long plain text read as a secret');
  const pw = 'hunter' + '2xyz';
  const late = plain + ' connect with postgres://admin:' + pw + '@db.example.com/app ' + plain.slice(0, 2000);
  assert.ok(MAP.findSecrets(late).length > 0, 'a secret after char 50000 was missed');
});
