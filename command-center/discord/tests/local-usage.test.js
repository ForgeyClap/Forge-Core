import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// FU-DISCORD (B8 security HIGH): de verbruiksbron mag NOOIT het Claude-
// credentials-bestand openen en NOOIT een netwerkverzoek doen. Alles komt uit
// de lokale Claude Code-transcripts (alleen de usage-velden).
const MODULE = process.env.FORGE_USAGE_MODULE ?? '../src/local-usage.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Kanarie: een nep-credentialsbestand. Een module die dit leest of een
  // netwerkverzoek doet, faalt de test.
  fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'CANARY-NOT-A-REAL-TOKEN' } }),
  );
  return home;
}

function line({ id, ts, model = 'claude-opus-5-5', usage, content = 'GEHEIME-INHOUD-MAG-NIET-LEKKEN' }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: content }], usage },
  });
}

function writeTranscripts(home) {
  const proj = path.join(home, '.claude', 'projects', 'C--demo');
  fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
  const u = (i, o, cr = 0, cc = 0) => ({
    input_tokens: i,
    output_tokens: o,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cc,
  });
  const main = [
    // 1 uur geleden; dezelfde message-id twee keer (gestreamde blokken) → één keer tellen, hoogste output.
    line({ id: 'msg_a', ts: NOW - 1 * HOUR, usage: u(10, 50, 1000, 200) }),
    line({ id: 'msg_a', ts: NOW - 1 * HOUR + 500, usage: u(10, 80, 1000, 200) }),
    // 3 uur geleden, ander model.
    line({ id: 'msg_b', ts: NOW - 3 * HOUR, model: 'claude-fable-5-1', usage: u(5, 20, 0, 0) }),
    // 2 dagen geleden: alleen in het 7-dagenvenster.
    line({ id: 'msg_c', ts: NOW - 48 * HOUR, usage: u(100, 400, 0, 0) }),
    // 9 dagen geleden: valt buiten beide vensters.
    line({ id: 'msg_old', ts: NOW - 9 * 24 * HOUR, usage: u(9999, 9999, 0, 0) }),
    // Gebruikersregel zonder usage en een kapotte regel: worden genegeerd.
    JSON.stringify({ type: 'user', timestamp: new Date(NOW - HOUR).toISOString(), message: { content: 'hoi' } }),
    '{kapot',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), main);
  // Subagent-transcript telt ook mee.
  fs.writeFileSync(
    path.join(proj, 'sess-1', 'subagents', 'agent-x.jsonl'),
    line({ id: 'msg_sub', ts: NOW - 2 * HOUR, model: 'claude-sonnet-5-5', usage: u(1, 9, 0, 0) }) + '\n',
  );
  // Workflow-agents liggen dieper: projects/<p>/<sessie>/subagents/workflows/<wf>/<agent>.jsonl
  const wf = path.join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(
    path.join(wf, 'agent-y.jsonl'),
    line({ id: 'msg_wf', ts: NOW - 4 * HOUR, model: 'claude-opus-5-5', usage: u(2, 30, 0, 0) }) + '\n',
  );
}

function spyFsAndFetch() {
  const touched = [];
  const names = ['readFileSync', 'openSync', 'createReadStream', 'readFile', 'open', 'statSync', 'existsSync'];
  const originals = {};
  for (const n of names) {
    originals[n] = fs[n];
    fs[n] = function spied(p, ...rest) {
      touched.push(String(p));
      return originals[n].call(this, p, ...rest);
    };
  }
  const promOrig = { readFile: fs.promises.readFile, open: fs.promises.open };
  fs.promises.readFile = (p, ...r) => {
    touched.push(String(p));
    return promOrig.readFile(p, ...r);
  };
  fs.promises.open = (p, ...r) => {
    touched.push(String(p));
    return promOrig.open(p, ...r);
  };
  const fetchCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls.push(String(args[0]));
    throw new Error('netwerk verboden in deze test');
  };
  return {
    touched,
    fetchCalls,
    restore() {
      for (const n of names) fs[n] = originals[n];
      fs.promises.readFile = promOrig.readFile;
      fs.promises.open = promOrig.open;
      globalThis.fetch = origFetch;
    },
  };
}

async function loadWithHome(home) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // Unieke query: forceer een verse module-evaluatie met de nep-HOME.
    return await import(`${MODULE}?home=${encodeURIComponent(home)}`);
  } finally {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.HOME === undefined) delete process.env.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
  }
}

test('verbruik: raakt NOOIT het credentials-bestand aan en doet GEEN netwerkverzoek (nep-HOME)', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const spy = spyFsAndFetch();
  let res;
  try {
    const mod = await loadWithHome(home);
    const Cls = mod.LocalUsage ?? mod.SubscriptionUsage;
    let fetchArgs = 0;
    const u = new Cls({
      homeDir: home,
      now: () => NOW,
      // Een oude implementatie die fetchImpl aanneemt, zou hier aanroepen.
      fetchImpl: async () => {
        fetchArgs += 1;
        return { ok: true, json: async () => ({ limits: [] }) };
      },
    });
    res = await u.get({ force: true });
    assert.equal(fetchArgs, 0, 'mag geen fetchImpl aanroepen');
  } finally {
    spy.restore();
  }
  const credHits = spy.touched.filter((p) => /credentials/i.test(p));
  assert.deepEqual(credHits, [], `credentials-pad aangeraakt: ${credHits.join(', ')}`);
  assert.deepEqual(spy.fetchCalls, [], 'geen netwerkverzoek toegestaan');
  assert.ok(res);
});

test('verbruik: telt tokens per venster (5 uur / 7 dagen), ontdubbelt per message-id, incl. subagents', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const res = await new LocalUsage({ homeDir: home, now: () => NOW }).get({ force: true });
  assert.equal(res.unavailable, undefined);
  assert.equal(res.estimate, true);
  const five = res.windows.find((w) => w.kind === 'session');
  const week = res.windows.find((w) => w.kind === 'weekly_all');
  // 5 uur: msg_a (10/80/1000/200) + msg_b (5/20) + msg_sub (1/9) + msg_wf (2/30, workflow-diepte)
  assert.deepEqual(five.tokens, { input: 18, output: 139, cacheRead: 1000, cacheCreate: 200 });
  assert.equal(five.messages, 4);
  // 7 dagen: + msg_c (100/400); msg_old valt erbuiten.
  assert.deepEqual(week.tokens, { input: 118, output: 539, cacheRead: 1000, cacheCreate: 200 });
  assert.equal(week.messages, 5);
  assert.equal(week.byModel['claude-fable-5-1'], 25);
  // Geen verzonnen percentages: zonder officiële limieten is er geen piek.
  assert.deepEqual(res.limits, []);
  assert.equal(LocalUsage.peak(res), null);
});

test('verbruik: weergave is NL, als schatting gelabeld en lekt geen berichtinhoud', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const res = await new LocalUsage({ homeDir: home, now: () => NOW }).get({ force: true });
  const txt = LocalUsage.format(res);
  assert.match(txt, /schatting/i);
  assert.match(txt, /lokale Claude Code-logs/);
  assert.match(txt, /Laatste 5 uur/);
  assert.match(txt, /Laatste 7 dagen/);
  assert.equal(txt.includes('GEHEIME-INHOUD'), false);
  assert.equal(JSON.stringify(res).includes('GEHEIME-INHOUD'), false, 'resultaat bevat alleen usage-cijfers');
});

test('verbruik: geen transcripts → eerlijke "niet beschikbaar" in het Nederlands, geen crash', async () => {
  const home = fakeHome(); // zonder projects-map
  const { LocalUsage } = await import(MODULE);
  const res = await new LocalUsage({ homeDir: home, now: () => NOW }).get({ force: true });
  assert.ok(res.unavailable);
  assert.deepEqual(res.limits, []);
  const txt = LocalUsage.format(res);
  assert.match(txt, /niet beschikbaar/);
  assert.equal(LocalUsage.peak(res), null);
});

test('verbruik wordt gecachet (geen herhaalde scan per commando)', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  let t = NOW;
  const u = new LocalUsage({ homeDir: home, now: () => t, cacheMs: 60_000 });
  const first = await u.get();
  // Nieuw transcript na de eerste scan: binnen de cachetijd niet zichtbaar.
  fs.writeFileSync(
    path.join(home, '.claude', 'projects', 'C--demo', 'later.jsonl'),
    line({ id: 'msg_new', ts: NOW - HOUR, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n',
  );
  t += 10_000;
  assert.equal(await u.get(), first);
  t += 120_000;
  const third = await u.get();
  assert.notEqual(third, first);
});

test('verbruik: oude modulenaam is weg (bron mag niet meer meegeleverd worden)', () => {
  const old = new URL('../src/subscription-usage.js', import.meta.url);
  assert.equal(fs.existsSync(old), false);
});

test('usage-guard: lokale schatting pauzeert nooit op verbruik, en heft een oude verbruik-pauze op', async () => {
  const { UsageGuard } = await import('../src/usage-guard.js');
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-guard-'));
  const meldingen = [];
  const guard = new UsageGuard({
    subscriptionUsage: new LocalUsage({ homeDir: home, now: () => NOW }),
    stateDir,
    notify: async (t) => meldingen.push(t),
  });
  await guard.evaluate();
  assert.equal(guard.paused, false, 'geen percentage → geen verzonnen verbruik-pauze');
  // Een pauze uit de oude percentage-bron kan nooit meer zakken: niet eeuwig vastzitten.
  guard.state = { paused: true, reason: 'verbruik op 95% (pauzeren vanaf 90%)', since: 0, notified: true, manual: false };
  await guard.evaluate();
  assert.equal(guard.paused, false);
  // Een handmatige pauze blijft altijd staan.
  guard.pauseManually();
  await guard.evaluate();
  assert.equal(guard.paused, true);
});

// w2-discord (review/security MEDIUM): een echte pauze op de lokale schatting.
// Zonder officiële limieten pauzeert de bot op een EIGEN tokenbudget per venster
// (TOKEN_BUDGET_5H / TOKEN_BUDGET_WEEK). Geteld: invoer + uitvoer + cache-schrijven
// (cache-lezen niet: dat zijn herhaalde, goedkope tokens die de som anders domineren).
// Fixture: 5 uur = 18 + 139 + 200 = 357, 7 dagen = 118 + 539 + 200 = 857.

test('budget: met een eigen tokenbudget krijgt elk venster een percentage (schatting)', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const res = await new LocalUsage({
    homeDir: home,
    now: () => NOW,
    budgets: { session: 400, weekly_all: 1000 },
  }).get({ force: true });
  const s = res.limits.find((l) => l.kind === 'session');
  const w = res.limits.find((l) => l.kind === 'weekly_all');
  assert.equal(s.used, 357);
  assert.equal(s.budget, 400);
  assert.equal(s.percent, 89);
  assert.equal(w.used, 857);
  assert.equal(w.percent, 86);
  assert.equal(LocalUsage.peak(res), 89);
  const txt = LocalUsage.format(res);
  assert.match(txt, /89% van je eigen budget/);
  assert.match(txt, /schatting/i);
});

test('budget: alleen een geldig, positief budget telt; ongeldig of 0 = uit (geen percentage)', async () => {
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const res = await new LocalUsage({
    homeDir: home,
    now: () => NOW,
    budgets: { session: 0, weekly_all: -5 },
  }).get({ force: true });
  assert.deepEqual(res.limits, []);
  assert.equal(LocalUsage.peak(res), null);
  const half = await new LocalUsage({ homeDir: home, now: () => NOW, budgets: { weekly_all: 'abc', session: 714 } }).get({
    force: true,
  });
  assert.deepEqual(half.limits.map((l) => [l.kind, l.percent]), [['session', 50]]);
});

test('usage-guard: pauzeert echt op het eigen tokenbudget, één melding, en hervat onder RESUME', async () => {
  const { UsageGuard } = await import('../src/usage-guard.js');
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-guard-'));
  const meldingen = [];
  const guard = new UsageGuard({
    subscriptionUsage: new LocalUsage({ homeDir: home, now: () => NOW, budgets: { session: 357 } }),
    stateDir,
    pauseAtPercent: 90,
    resumeAtPercent: 80,
    notify: async (t) => meldingen.push(t),
  });
  await guard.evaluate();
  assert.equal(guard.paused, true, '100% van het eigen 5-uursbudget → pauze');
  assert.match(guard.reason(), /100% van je eigen tokenbudget/);
  assert.match(guard.reason(), /schatting/);
  await guard.evaluate();
  assert.equal(meldingen.length, 1, 'precies één melding, geen statusloop');
  // Budget ruimer (of het venster schuift door): 357/1000 = 36% ≤ 80% → hervatten.
  guard.subscriptionUsage = new LocalUsage({ homeDir: home, now: () => NOW, budgets: { session: 1000 } });
  await guard.evaluate();
  assert.equal(guard.paused, false);
  assert.equal(meldingen.length, 2);
});

test('usage-guard: onder de pauzegrens van het budget blijft hij lopen; tussen resume en pauze blijft een pauze staan', async () => {
  const { UsageGuard } = await import('../src/usage-guard.js');
  const home = fakeHome();
  writeTranscripts(home);
  const { LocalUsage } = await import(MODULE);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-guard-'));
  const guard = new UsageGuard({
    subscriptionUsage: new LocalUsage({ homeDir: home, now: () => NOW, budgets: { session: 420 } }), // 85%
    stateDir,
    pauseAtPercent: 90,
    resumeAtPercent: 80,
  });
  await guard.evaluate();
  assert.equal(guard.paused, false);
  guard.state = { paused: true, reason: 'verbruik op 92% van je eigen tokenbudget', since: 0, notified: true, manual: false };
  await guard.evaluate();
  assert.equal(guard.paused, true, '85% > RESUME 80% → pauze blijft');
});

test('config: TOKEN_BUDGET_5H / TOKEN_BUDGET_WEEK worden gelezen; leeg/ongeldig/negatief = 0 (uit)', async () => {
  const { loadConfig } = await import('../src/config.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-cfg-')); // geen .env hier
  const a = loadConfig({ env: { TOKEN_BUDGET_5H: '2000000', TOKEN_BUDGET_WEEK: '30000000' }, cwd });
  assert.deepEqual(a.tokenBudgets, { session: 2000000, weekly_all: 30000000 });
  const b = loadConfig({ env: { TOKEN_BUDGET_5H: 'veel', TOKEN_BUDGET_WEEK: '-3' }, cwd });
  assert.deepEqual(b.tokenBudgets, { session: 0, weekly_all: 0 });
  const c = loadConfig({ env: {}, cwd });
  assert.deepEqual(c.tokenBudgets, { session: 0, weekly_all: 0 });
});

test('docs: README en .env.example beloven geen pauze zonder budget en documenteren het tokenbudget', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.equal(/automatische pauze boven 90% verbruik/.test(readme), false);
  assert.match(readme, /TOKEN_BUDGET_5H/);
  assert.match(example, /^TOKEN_BUDGET_5H=0$/m);
  assert.match(example, /^TOKEN_BUDGET_WEEK=0$/m);
  assert.match(example, /schatting/i);
});
