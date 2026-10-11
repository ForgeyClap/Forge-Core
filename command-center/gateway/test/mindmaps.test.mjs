// unit tests for mindmaps.mjs (listMindmaps / readMindmap / normalizeMap) against isolated temp
// project folders — never the real fleet. The HTTP-level route tests live in routes-mindmaps.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listMindmaps, readMindmap, normalizeMap, safeMapIdOk, MAX_MAP_BYTES } from '../src/mindmaps.mjs';

const temps = [];
function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mindmaps-unit-'));
  temps.push(dir);
  return dir;
}
function writeMap(projectDir, id, obj) {
  const dir = path.join(projectDir, '.claude', 'forge-mindmaps');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return file;
}
const SAMPLE = {
  map_id: 'm1', title: 'Mission', _generated: '2026-10-01T10:00:00.000Z',
  nodes: [
    { id: 'root', label: 'Mission', kind: 'root', parent: null },
    { id: 'a', label: 'A', kind: 'leaf', parent: 'root' },
    { id: 'b', label: 'B', kind: 'leaf', parent: 'root' },
  ],
  edges: [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }],
};

after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

test('no forge-mindmaps folder -> honest NOT GENERATED with an empty list, never an error', () => {
  const r = listMindmaps(freshProject());
  assert.equal(r.ok, true);
  assert.equal(r.available, false);
  assert.equal(r.provenance, 'NOT GENERATED');
  assert.deepEqual(r.maps, []);
});

test('lists every valid map with real counts, newest first; skips sidecars and index.jsonl', () => {
  const p = freshProject();
  writeMap(p, 'older', { ...SAMPLE, map_id: 'older', _generated: '2026-09-01T00:00:00.000Z' });
  writeMap(p, 'newer', { ...SAMPLE, map_id: 'newer', title: 'Newer' });
  const dir = path.join(p, '.claude', 'forge-mindmaps');
  fs.writeFileSync(path.join(dir, 'newer.mmd'), 'graph TD\n');
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '{"id":"newer"}\n');
  fs.writeFileSync(path.join(dir, 'bad name.json'), '{}'); // id fails the allowlist -> ignored
  const r = listMindmaps(p);
  assert.equal(r.available, true);
  assert.equal(r.provenance, 'LIVE');
  assert.deepEqual(r.maps.map((m) => m.id), ['newer', 'older']);
  assert.equal(r.maps[0].title, 'Newer');
  assert.equal(r.maps[0].node_count, 3);
  assert.equal(r.maps[0].edge_count, 2);
  assert.equal(r.maps[0].generated_at_source, 'file');
});

test('an unparsable map is counted as unreadable, never listed and never a crash', () => {
  const p = freshProject();
  writeMap(p, 'good', SAMPLE);
  writeMap(p, 'broken', '{ not json');
  const r = listMindmaps(p);
  assert.deepEqual(r.maps.map((m) => m.id), ['good']);
  assert.equal(r.unreadable, 1);
  const one = readMindmap(p, 'broken');
  assert.equal(one.status, 422);
});

test('readMindmap returns the normalized map', () => {
  const p = freshProject();
  writeMap(p, 'm1', SAMPLE);
  const r = readMindmap(p, 'm1');
  assert.equal(r.status, 200);
  assert.equal(r.body.map.map_id, 'm1');
  assert.equal(r.body.map.nodes.length, 3);
  assert.equal(r.body.map.edges.length, 2);
  assert.equal(r.body.map.generated_at, '2026-10-01T10:00:00.000Z');
});

test('SECURITY: traversal-shaped ids are rejected before any path is built', () => {
  const p = freshProject();
  writeMap(p, 'm1', SAMPLE);
  for (const id of ['../m1', '..', 'a/b', 'a\\b', 'm1.json', '', 'C:', '%2e%2e', 'x'.repeat(129)]) {
    assert.equal(safeMapIdOk(id), false, 'id must be refused: ' + JSON.stringify(id));
    assert.equal(readMindmap(p, id).status, 400);
  }
  assert.equal(readMindmap(p, 'does-not-exist').status, 404);
});

test('SECURITY: a forge-mindmaps folder that is a junction to somewhere else is refused, never read', (t) => {
  const p = freshProject();
  const elsewhere = freshProject();
  writeMap(elsewhere, 'secret', SAMPLE);
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  try {
    fs.symlinkSync(path.join(elsewhere, '.claude', 'forge-mindmaps'), path.join(p, '.claude', 'forge-mindmaps'), 'junction');
  } catch (err) {
    t.skip('junction creation not possible here: ' + err.message);
    return;
  }
  const r = listMindmaps(p);
  assert.equal(r.available, false);
  assert.equal(r.provenance, 'REFUSED');
  assert.equal(readMindmap(p, 'secret').status, 404);
});

test('SECURITY: an over-sized map file is refused with 413 and not parsed', () => {
  const p = freshProject();
  writeMap(p, 'huge', '{"nodes":[' + ' '.repeat(MAX_MAP_BYTES + 10) + ']}');
  assert.equal(readMindmap(p, 'huge').status, 413);
  assert.equal(listMindmaps(p).unreadable, 1);
});

test('normalizeMap drops dangling/self/duplicate edges and id-less nodes, redacts secrets, never throws', () => {
  const fakeKey = 'sk-ant-api03-' + 'A'.repeat(40);
  const m = normalizeMap({
    title: 'leak ' + fakeKey,
    nodes: [{ id: 'r', label: 'R', kind: 'root' }, { id: 'r', label: 'dup' }, { label: 'no id' }, { id: 'c', label: fakeKey, kind: 'weird' }],
    edges: [{ from: 'r', to: 'c' }, { from: 'r', to: 'c' }, { from: 'r', to: 'ghost' }, { from: 'c', to: 'c' }],
  }, 'x');
  assert.deepEqual(m.nodes.map((n) => n.id), ['r', 'c']);
  assert.equal(m.nodes[1].kind, null);
  assert.equal(m.edges.length, 1);
  assert.equal(m.dropped_nodes, 2);
  assert.equal(m.dropped_edges, 3);
  assert.ok(!JSON.stringify(m).includes(fakeKey), 'a secret-shaped string must be redacted');
  assert.doesNotThrow(() => normalizeMap(null, 'x'));
  assert.deepEqual(normalizeMap('garbage', 'x').nodes, []);
});
