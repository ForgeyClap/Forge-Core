// "Eigen API": the new provider modules ship inside the desktop app, so they carry none of the
// never-ship content patterns of the desktop distribution check (P1-P10). 0 hits expected; the matcher is
// the real check, proven to see a planted needle first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBuffer } from '../../desktop/scripts/distribution-check.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FILES = [
  'providers/custom-rules.mjs', 'providers/custom-store.mjs', 'providers/custom-registry.mjs',
  'providers/provider-base.mjs', 'providers/adapters/anthropic.mjs', 'providers/provider-hub.mjs', 'models.mjs',
];

test('the matcher sees a planted needle', () => {
  assert.equal(scanBuffer(Buffer.from('x forge-' + 'accounts y')).length, 1);
});

test('the Eigen API modules and the files they touch have no never-ship hit', () => {
  const hits = [];
  for (const rel of FILES) {
    const file = path.join(SRC, rel);
    assert.ok(fs.existsSync(file), rel + ' missing');
    for (const h of scanBuffer(fs.readFileSync(file))) hits.push(rel + ' ' + h.pattern_id + '@' + h.offset);
  }
  assert.deepEqual(hits, []);
});
