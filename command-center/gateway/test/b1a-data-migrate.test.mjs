// WP B1a: data-migrate.mjs copies a data dir to a new location: dry-run by default, sha256 per
// file, never overwrites a target file, never touches the source, writes its report into the target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateDataDir, validateDirs, parseArgs, sha256File, EXIT } from '../src/data-migrate.mjs';

const CLI = fileURLToPath(new URL('../src/data-migrate.mjs', import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b1a-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, 'old', '.data');
  const to = path.join(root, 'AppData', 'Forge Systeem');
  const files = {
    'conversations/c-1.jsonl': '{"type":"turn","text":"hallo"}\n',
    'conversations/_claude-sessions.json': '{"schema":1}\n',
    'attachments/c-1/plaatje.bin': Buffer.from([0, 1, 2, 3, 255]),
    'discord/state/desired-state.json': '{"on":true}\n',
    'agent-model-edits.jsonl': '{"agent":"build-boss"}\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(from, rel)), { recursive: true });
    fs.writeFileSync(path.join(from, rel), body);
  }
  return { root, from, to, files };
}

function snapshot(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else out[rel] = sha256File(path.join(d, e.name));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

test('dry-run copies nothing, hashes every file, writes the report into the target, leaves the source alone', (t) => {
  const f = makeFixture(t);
  const before = snapshot(f.from);
  const r = migrateDataDir({ from: f.from, to: f.to });
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.report.mode, 'dry-run');
  assert.equal(r.report.counts.copy, 5);
  assert.equal(r.report.source_deleted, false);
  for (const e of r.report.files) {
    const body = f.files[e.path.split(path.sep).join('/')];
    assert.equal(e.sha256, sha(body), 'hash of ' + e.path);
  }
  assert.deepEqual(Object.keys(snapshot(f.to)), [path.basename(r.reportPath)], 'only the report exists in the target');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.reportPath, 'utf8')).counts, r.report.counts);
  assert.deepEqual(snapshot(f.from), before, 'source unchanged');
});

test('apply copies new files with verified hashes, keeps identical ones, never overwrites a conflict', (t) => {
  const f = makeFixture(t);
  fs.mkdirSync(path.join(f.to, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(f.to, 'conversations', 'c-1.jsonl'), 'NEWER DATA IN TARGET\n'); // conflict
  fs.writeFileSync(path.join(f.to, 'agent-model-edits.jsonl'), f.files['agent-model-edits.jsonl']); // identical
  const before = snapshot(f.from);

  const r = migrateDataDir({ from: f.from, to: f.to, apply: true });
  assert.equal(r.exitCode, EXIT.CONFLICTS);
  assert.deepEqual(r.report.counts, { conflict: 1, copied: 3, identical: 1 });
  assert.equal(fs.readFileSync(path.join(f.to, 'conversations', 'c-1.jsonl'), 'utf8'), 'NEWER DATA IN TARGET\n', 'conflict untouched');
  for (const rel of ['conversations/_claude-sessions.json', 'attachments/c-1/plaatje.bin', 'discord/state/desired-state.json']) {
    assert.equal(sha256File(path.join(f.to, rel)), sha(f.files[rel]), 'copied ' + rel);
  }
  assert.deepEqual(snapshot(f.from), before, 'source never deleted or changed');

  const rerun = migrateDataDir({ from: f.from, to: f.to, apply: true, now: new Date(Date.now() + 1000) });
  assert.deepEqual(rerun.report.counts, { conflict: 1, identical: 4 }, 'a second apply is idempotent');
});

test('validateDirs refuses missing source, nested dirs and network paths', (t) => {
  const f = makeFixture(t);
  assert.match(validateDirs(path.join(f.root, 'nope'), f.to).error, /does not exist/);
  assert.match(validateDirs(f.from, path.join(f.from, 'inner')).error, /inside each other/);
  assert.match(validateDirs(f.from, f.from).error, /inside each other/);
  assert.match(validateDirs('\\\\host\\share\\x', f.to).error, /network or device/);
  assert.equal(migrateDataDir({ from: f.from, to: f.from }).exitCode, EXIT.USAGE);
});

test('parseArgs and the CLI: dry-run by default, exit codes are honest', (t) => {
  assert.deepEqual(parseArgs(['--from', 'a', '--to', 'b']), { from: 'a', to: 'b', apply: false });
  assert.match(parseArgs(['--from']).error, /needs a value/);
  assert.match(parseArgs(['--delete-source']).error, /unknown argument/);

  const f = makeFixture(t);
  const dry = spawnSync(process.execPath, [CLI, '--from', f.from, '--to', f.to], { encoding: 'utf8', timeout: 20000 });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /data-migrate dry-run: \{"copy":5\} \(source untouched\)/);
  assert.ok(!fs.existsSync(path.join(f.to, 'conversations')), 'dry-run copied nothing');

  const applied = spawnSync(process.execPath, [CLI, '--from', f.from, '--to', f.to, '--apply'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /data-migrate apply: \{"copied":5\}/);

  const bad = spawnSync(process.execPath, [CLI, '--to', f.to], { encoding: 'utf8', timeout: 20000 });
  assert.equal(bad.status, EXIT.USAGE);
  assert.match(bad.stderr, /--from is required/);
});
