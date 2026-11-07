import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LocalUsage, bar, resetIn } from '../src/local-usage.js';
import { progressFromEvent, parseStream, buildArgs } from '../src/runner-claude.js';
import { scanRecent, formatDiff } from '../src/project-diff.js';
import { RunStatus } from '../src/run-status.js';
import { MockTransport } from '../src/transport/mock.js';
import { tmpStateDir } from './helpers.js';

// De verbruiksbron zelf (lokale logs, geen token, geen netwerk) wordt getest in
// tests/local-usage.test.js. Hier alleen de gedeelde weergavehulpjes.

test('usage-balk en resettijd zijn correct', () => {
  assert.equal(bar(0, 10), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(bar(100, 10), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(bar(50, 10), '▰▰▰▰▰▱▱▱▱▱');
  // One fixed clock for the input AND for resetIn: reading Date.now() twice made 3 h come out as 2.999 h -> '2u' under load.
  const now = Date.now();
  assert.equal(resetIn(new Date(now + 3 * 3600 * 1000).toISOString(), now), '3u');
  assert.equal(resetIn(new Date(now + 2 * 86400 * 1000).toISOString(), now), '2d');
  assert.equal(resetIn(new Date(now - 1000).toISOString(), now), 'nu');
});

test('peak: echte limieten geven het hoogste percentage, geen limieten geven null (onbekend)', () => {
  assert.equal(LocalUsage.peak({ limits: [{ percent: 35 }, { percent: 19 }] }), 35);
  assert.equal(LocalUsage.peak({ limits: [] }), null);
  assert.equal(LocalUsage.peak({ unavailable: 'x', limits: [] }), null);
});

test('live voortgang: tool-events worden korte, leesbare regels', () => {
  const ev = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  assert.equal(progressFromEvent(ev('Read', { file_path: 'C:/p/index.html' })), 'leest index.html');
  assert.equal(progressFromEvent(ev('Write', { file_path: '/p/style.css' })), 'schrijft style.css');
  assert.equal(progressFromEvent(ev('Bash', { description: 'tests draaien' })), 'voert uit: tests draaien');
  assert.equal(progressFromEvent(ev('Grep', { pattern: 'TODO' })), 'zoekt: TODO');
  assert.equal(progressFromEvent({ type: 'system' }), null);
  assert.equal(progressFromEvent(null), null);
});

test('stream-json: eindresultaat wordt correct uit de stroom gehaald', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } }),
    JSON.stringify({ type: 'result', result: 'klaar!', session_id: 'sess-9', total_cost_usd: 0.03 }),
    '', // onvolledige laatste regel
  ].join('\n');
  const parsed = parseStream(stdout);
  assert.equal(parsed.answer, 'klaar!');
  assert.equal(parsed.sessionId, 'sess-9');
  assert.ok(buildArgs({ stream: true }).includes('stream-json'));
  assert.ok(buildArgs({}).includes('json'));
});

test('voortgang wordt gebundeld: hooguit één edit per interval', async () => {
  const transport = new MockTransport();
  const st = new RunStatus({ transport, ownerUserIds: ['o1'] });
  const item = { id: 'i1', threadId: 't1', content: 'test' };
  await st.begin(item, 'start');
  await st.running(item);
  const before = transport.edits.length;
  st.progress(item, 'leest a.txt'); // eerste stap: meteen zichtbaar
  st.progress(item, 'leest b.txt'); // daarna afgeremd
  st.progress(item, 'leest c.txt');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(transport.edits.length, before + 1, 'na de eerste stap mag er niet nog een edit komen');
  assert.equal(st.steps.get('i1').length, 3, 'stappen worden wel bijgehouden');
  await st.done(item);
  assert.ok(transport.edits[transport.edits.length - 1].content.includes('3 stappen'));
});

test('/forge diff: vindt recent gewijzigde bestanden, negeert node_modules', () => {
  const dir = tmpStateDir();
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'lib.js'), 'x');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1)');
  const files = scanRecent(dir, { sinceMs: 3600 * 1000 });
  const names = files.map((f) => f.file.replace(/\\/g, '/'));
  assert.ok(names.includes('index.html'));
  assert.ok(names.includes('src/app.js'));
  assert.equal(names.some((n) => n.includes('node_modules')), false);
  const txt = formatDiff({ projectId: 'p', path: dir }, files, { hours: 1 });
  assert.ok(txt.includes('Gewijzigd in p'));
  assert.ok(formatDiff({ projectId: 'p', path: dir }, [], { hours: 1 }).includes('Geen bestandswijzigingen'));
});
