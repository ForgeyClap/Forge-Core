import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// Verbruik als SCHATTING uit de lokale Claude Code-transcripts
// (~/.claude/projects/**/*.jsonl). Vervangt de oude bron die een OAuth-token
// uit het login-bestand las en een ongedocumenteerd endpoint aanriep
// (B8 security HIGH, opgelost 2026-11-02).
//
// Veiligheid: deze module opent ALLEEN .jsonl-bestanden onder
// <home>/.claude/projects, doet geen netwerkverzoek en neemt uit elke regel
// alleen tijdstempel, message-id, model en de usage-tellers over. Berichtinhoud
// wordt nooit bewaard, gelogd of teruggegeven.
//
// Eerlijkheid: zonder officiële abonnementslimieten zijn er geen abonnements-
// percentages. Alleen als de eigenaar zelf een tokenbudget per venster instelt
// (TOKEN_BUDGET_5H / TOKEN_BUDGET_WEEK) komt er per venster een percentage van
// DAT eigen budget in `limits`, zodat de usage-guard daarop kan pauzeren.
// Zonder budget blijft `limits` leeg en geeft `peak()` null (= onbekend):
// nooit een verzonnen cijfer.
//
// Geteld voor het budget: invoer + uitvoer + cache-schrijven. Cache-lezen telt
// niet mee: dat zijn herhaalde, goedkope tokens die de som anders domineren.

const HOUR = 3600 * 1000;
const WINDOWS = [
  { kind: 'session', label: 'Laatste 5 uur', ms: 5 * HOUR },
  { kind: 'weekly_all', label: 'Laatste 7 dagen', ms: 7 * 24 * HOUR },
];
const MAX_DEPTH = 8; // projects/<p>/<sessie>/subagents/workflows/<wf>/<agent>.jsonl = diepte 6, met marge
const MAX_FILES = 5000;
const SOURCE_LABEL = 'schatting uit lokale Claude Code-logs, geen officiële abonnementscijfers';

export function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function resetIn(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'nu';
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d`;
  return h >= 1 ? `${h}u` : `${Math.max(1, Math.round(ms / 60000))}m`;
}

/** Compact NL-getal: 1234 → "1,2k", 2_500_000 → "2,5 mln". */
export function compact(n) {
  const v = Number(n) || 0;
  const fmt = (x) => x.toFixed(1).replace('.', ',').replace(/,0$/, '');
  if (v >= 1e9) return `${fmt(v / 1e9)} mld`;
  if (v >= 1e6) return `${fmt(v / 1e6)} mln`;
  if (v >= 1e3) return `${fmt(v / 1e3)}k`;
  return String(Math.round(v));
}

function listTranscripts(root, sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          // Bestanden die al voor het venster niet meer gewijzigd zijn, overslaan.
          if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full);
        } catch {
          /* verdwenen tussen readdir en stat: negeren */
        }
      }
    }
  };
  walk(root, 1);
  return out;
}

/** Haalt uitsluitend de usage-velden uit één transcriptregel (of null). */
export function usageFromLine(raw) {
  if (!raw || !raw.includes('"usage"')) return null;
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  const u = o?.message?.usage;
  const ts = Date.parse(o?.timestamp ?? '');
  if (!u || typeof u !== 'object' || !Number.isFinite(ts)) return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return {
    id: String(o.message.id ?? o.requestId ?? o.uuid ?? `${ts}`),
    ts,
    model: typeof o.message.model === 'string' ? o.message.model : 'onbekend',
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
  };
}

async function scanFile(file, sinceMs, byId) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const rec = usageFromLine(raw);
    if (!rec || rec.ts < sinceMs) continue;
    // Gestreamde blokken van één bericht delen hun id: één keer tellen, hoogste waarden.
    const prev = byId.get(rec.id);
    if (!prev || rec.output >= prev.output) byId.set(rec.id, prev ? { ...rec, ts: Math.min(prev.ts, rec.ts) } : rec);
  }
}

/** Alleen een eindig, positief getal is een budget; al het andere = uit (0). */
export function normalizeBudget(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Tokens die tegen het eigen budget tellen (zie kop: cache-lezen niet). */
export function budgetTokens(t) {
  return t.input + t.output + t.cacheCreate;
}

export class LocalUsage {
  constructor({ cacheMs = 300_000, now = () => Date.now(), homeDir = null, budgets = {} } = {}) {
    this.cacheMs = cacheMs;
    this.now = now;
    this.homeDir = homeDir;
    this.budgets = Object.freeze({
      session: normalizeBudget(budgets?.session),
      weekly_all: normalizeBudget(budgets?.weekly_all),
    });
    this.cache = null;
  }

  get projectsDir() {
    return path.join(this.homeDir ?? os.homedir(), '.claude', 'projects');
  }

  async get({ force = false } = {}) {
    if (!force && this.cache && this.now() - this.cache.fetchedAt < this.cacheMs) return this.cache;
    const now = this.now();
    const sinceMs = now - Math.max(...WINDOWS.map((w) => w.ms));
    let result;
    try {
      const files = listTranscripts(this.projectsDir, sinceMs);
      if (files.length === 0) {
        result = { unavailable: 'geen recente lokale Claude Code-logs gevonden', limits: [], fetchedAt: now };
      } else {
        const byId = new Map();
        for (const f of files) {
          try {
            await scanFile(f, sinceMs, byId);
          } catch {
            /* één onleesbaar bestand mag de rest niet blokkeren */
          }
        }
        result = summarize([...byId.values()], now, files.length, this.budgets);
      }
    } catch (err) {
      result = {
        unavailable: `lokale logs niet te lezen (${String(err?.code ?? err?.message ?? err).slice(0, 40)})`,
        limits: [],
        fetchedAt: now,
      };
    }
    this.cache = result;
    return result;
  }

  // Compacte, mobiel-leesbare weergave (Nederlands).
  static format(usage) {
    if (usage.unavailable) return `📊 Verbruik: niet beschikbaar — ${usage.unavailable}.`;
    const lines = [`_(${SOURCE_LABEL})_`];
    for (const w of usage.windows ?? []) {
      const t = w.tokens;
      const total = t.input + t.output + t.cacheRead + t.cacheCreate;
      lines.push(
        `${w.label}: ${compact(total)} tokens — in ${compact(t.input)} · uit ${compact(t.output)} · cache ${compact(t.cacheRead + t.cacheCreate)} (${w.messages} antwoorden)`,
      );
    }
    const week = (usage.windows ?? []).find((w) => w.kind === 'weekly_all');
    const top = Object.entries(week?.byModel ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([m, n]) => `${m.replace(/^claude-/, '')} ${compact(n)}`);
    if (top.length) lines.push(`Per model (7 dagen, in+uit): ${top.join(' · ')}`);
    for (const l of usage.limits ?? []) {
      lines.push(`${l.label}: ${bar(l.percent)} ${l.percent}% van je eigen budget (${compact(l.used)} / ${compact(l.budget)} tokens)`);
    }
    return lines.join('\n');
  }

  // Hoogste percentage van het eigen budget; zonder budget null (= onbekend, nooit verzonnen).
  static peak(usage) {
    const limits = usage?.limits ?? [];
    if (limits.length === 0) return null;
    return limits.reduce((max, l) => Math.max(max, Number(l.percent) || 0), 0);
  }
}

function summarize(records, now, fileCount, budgets = {}) {
  const windows = WINDOWS.map((w) => {
    const from = now - w.ms;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    const byModel = {};
    let messages = 0;
    for (const r of records) {
      if (r.ts < from || r.ts > now) continue;
      messages += 1;
      tokens.input += r.input;
      tokens.output += r.output;
      tokens.cacheRead += r.cacheRead;
      tokens.cacheCreate += r.cacheCreate;
      byModel[r.model] = (byModel[r.model] ?? 0) + r.input + r.output;
    }
    return { kind: w.kind, label: w.label, tokens, byModel, messages };
  });
  // Rollend venster: er is geen vast resetmoment, dus geen resetsAt.
  const limits = windows
    .filter((w) => (budgets[w.kind] ?? 0) > 0)
    .map((w) => {
      const used = budgetTokens(w.tokens);
      const budget = budgets[w.kind];
      return { kind: w.kind, label: `Budget ${w.label.toLowerCase()}`, used, budget, percent: Math.round((used / budget) * 100) };
    });
  return { estimate: true, source: SOURCE_LABEL, windows, limits, files: fileCount, fetchedAt: now };
}
