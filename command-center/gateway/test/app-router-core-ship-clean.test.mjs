// App router P1 (design section 5.2 rule 2): the router sources carry none of the never-ship
// content patterns of the desktop distribution check (P1-P10). Scans src/app-router/** and
// src/routes/app-router.mjs (when present) with the check's own matcher; 0 hits expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBuffer, CONTENT_PATTERNS } from '../../desktop/scripts/distribution-check.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function routerSources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(path.join(SRC, 'app-router'));
  const route = path.join(SRC, 'routes', 'app-router.mjs');
  if (fs.existsSync(route)) out.push(route);
  return out;
}

test('the matcher is the real distribution check (all ten patterns present)', () => {
  assert.deepEqual(CONTENT_PATTERNS.map((p) => p.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
  // the matcher finds a planted needle, so 0 hits below means something
  assert.equal(scanBuffer(Buffer.from('x forge-' + 'accounts y')).length, 1);
});

test('router sources: at least the eight P1 modules exist and none has a never-ship hit', () => {
  const files = routerSources();
  const names = files.map((f) => path.basename(f));
  for (const m of ['contract', 'chain-schema', 'chain-store', 'select', 'usage-readings', 'replay', 'profiles', 'router-log']) {
    assert.ok(names.includes(m + '.mjs'), m + '.mjs missing');
  }
  const hits = [];
  for (const f of files) {
    for (const h of scanBuffer(fs.readFileSync(f))) hits.push(path.relative(SRC, f) + ' ' + h.pattern_id + '@' + h.offset);
  }
  assert.deepEqual(hits, []);
});
