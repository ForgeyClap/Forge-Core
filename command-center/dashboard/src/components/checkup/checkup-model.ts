/**
 * checkup-model — "Controleer of alles werkt" (WP B6, plan §4.6), the pure part.
 *
 * `GET /api/checkup` (gateway/src/checkup.mjs) answers with what this pc has: Claude Code (found,
 * version, signed in), Codex, Ollama (running, models), Node.js, Git, free disk space, the port
 * Forge uses and whether the project folder is writable. This module parses that answer, turns it
 * into one row per check with a single fix action, and builds the redacted text behind
 * "Diagnose kopiëren". No React here, so every rule is unit-tested on its own.
 *
 * Honesty: a field the gateway did not send stays `null` and becomes an "unknown" row, never a
 * guessed tick.
 */

import { gwGet, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

export interface CheckupResult {
  readonly claude: { readonly found: boolean; readonly version: string | null; readonly signedIn: boolean | null };
  readonly codex: { readonly found: boolean; readonly version: string | null };
  readonly ollama: { readonly found: boolean; readonly up: boolean; readonly models: readonly string[] };
  readonly node: { readonly version: string | null };
  readonly git: { readonly found: boolean; readonly version: string | null };
  readonly diskFreeGb: number | null;
  readonly port: number | null;
  readonly writableProjectDir: boolean | null;
  readonly checkedAt: string | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean;
}

/** Below this, the disk row turns red: a local model alone can take several GB. */
export const LOW_DISK_GB = 5;

function stringList(record: Record<string, unknown> | null, key: string): readonly string[] {
  if (record === null) return [];
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Maps the route's JSON 1:1; anything missing becomes `false`/`null`/`[]`, never a plausible yes. */
export function parseCheckup(data: Record<string, unknown>): CheckupResult {
  const claude = pickRecord(data, ['claude']);
  const codex = pickRecord(data, ['codex']);
  const ollama = pickRecord(data, ['ollama']);
  const node = pickRecord(data, ['node']);
  const git = pickRecord(data, ['git']);
  return {
    claude: {
      found: (claude && pickBool(claude, ['found'])) ?? false,
      version: claude ? pickString(claude, ['version']) : null,
      signedIn: claude ? pickBool(claude, ['signedIn']) : null,
    },
    codex: { found: (codex && pickBool(codex, ['found'])) ?? false, version: codex ? pickString(codex, ['version']) : null },
    ollama: {
      found: (ollama && pickBool(ollama, ['found'])) ?? false,
      up: (ollama && pickBool(ollama, ['up'])) ?? false,
      models: stringList(ollama, 'models'),
    },
    node: { version: node ? pickString(node, ['version']) : null },
    git: { found: (git && pickBool(git, ['found'])) ?? false, version: git ? pickString(git, ['version']) : null },
    diskFreeGb: pickNumber(data, ['disk_free_gb']),
    port: pickNumber(data, ['port']),
    writableProjectDir: pickBool(data, ['writable_project_dir']),
    checkedAt: pickString(data, ['checked_at']),
    durationMs: pickNumber(data, ['duration_ms']),
    timedOut: pickBool(data, ['timed_out']) ?? false,
  };
}

export type CheckupFetch = { readonly ok: true; readonly result: CheckupResult } | { readonly ok: false; readonly error: string };

/** One real call to the gateway. `projectDir` adds the "may Forge write here" row. */
export async function fetchCheckup(projectDir?: string | null): Promise<CheckupFetch> {
  const query = projectDir ? `?dir=${encodeURIComponent(projectDir)}` : '';
  const response = await gwGet(`/api/checkup${query}`);
  if (!response.ok) return { ok: false, error: response.error };
  if (pickBool(response.data, ['ok']) !== true) return { ok: false, error: 'unexpected answer' };
  return { ok: true, result: parseCheckup(response.data) };
}

/* ------------------------------------------------------------------ rows */

export type CheckId = 'claude' | 'signedIn' | 'codex' | 'ollama' | 'node' | 'git' | 'disk' | 'port' | 'folder';

/** ok = tick, fail = cross, optional = not needed for every path (grey), unknown = could not tell. */
export type CheckState = 'ok' | 'fail' | 'optional' | 'unknown';

/** The one fix per row. `help` actions open an explanation with the exact command. */
export type FixAction =
  | 'installClaude'
  | 'login'
  | 'installCodex'
  | 'startOllama'
  | 'installOllama'
  | 'installGit'
  | 'freeDisk'
  | 'chooseFolder'
  | 'recheck';

/** Which message to show; the key lives under `checkup.rows.<id>.<message>` in the locale files. */
export interface CheckRow {
  readonly id: CheckId;
  readonly state: CheckState;
  readonly message: string;
  readonly vars: Readonly<Record<string, string | number>>;
  readonly fix: FixAction | null;
}

/** The exact commands behind a fix, shown under "Technische details". Not translated: commands. */
export const FIX_COMMANDS: Readonly<Partial<Record<FixAction, string>>> = {
  installClaude: 'npm install -g @anthropic-ai/claude-code',
  login: 'claude auth login',
  installCodex: 'npm install -g @openai/codex',
  startOllama: 'ollama serve',
  installOllama: 'winget install Ollama.Ollama',
  installGit: 'winget install Git.Git',
};

export interface CheckRowOptions {
  /** Show the port row (Uitgebreid only: no port in Eenvoudig, plan §4.6). */
  readonly showPort: boolean;
  /** BCP 47 tag for number formatting ('nl' writes 204,8). */
  readonly locale: string;
}

export function buildCheckRows(result: CheckupResult, options: CheckRowOptions): readonly CheckRow[] {
  const rows: CheckRow[] = [];
  const { claude, codex, ollama, git } = result;

  rows.push(
    claude.found
      ? { id: 'claude', state: 'ok', message: claude.version ? 'ok' : 'okNoVersion', vars: { version: claude.version ?? '' }, fix: null }
      : { id: 'claude', state: 'fail', message: 'fail', vars: {}, fix: 'installClaude' },
  );
  if (claude.found) {
    if (claude.signedIn === true) rows.push({ id: 'signedIn', state: 'ok', message: 'ok', vars: {}, fix: null });
    else if (claude.signedIn === false) rows.push({ id: 'signedIn', state: 'fail', message: 'fail', vars: {}, fix: 'login' });
    else rows.push({ id: 'signedIn', state: 'unknown', message: 'unknown', vars: {}, fix: 'recheck' });
  }

  rows.push(
    codex.found
      ? { id: 'codex', state: 'ok', message: codex.version ? 'ok' : 'okNoVersion', vars: { version: codex.version ?? '' }, fix: null }
      : { id: 'codex', state: 'optional', message: 'fail', vars: {}, fix: 'installCodex' },
  );

  if (ollama.up) rows.push({ id: 'ollama', state: 'ok', message: 'ok', vars: { count: ollama.models.length }, fix: null });
  else if (ollama.found) rows.push({ id: 'ollama', state: 'fail', message: 'stopped', vars: {}, fix: 'startOllama' });
  else rows.push({ id: 'ollama', state: 'optional', message: 'fail', vars: {}, fix: 'installOllama' });

  rows.push(
    result.node.version
      ? { id: 'node', state: 'ok', message: 'ok', vars: { version: result.node.version }, fix: null }
      : { id: 'node', state: 'unknown', message: 'unknown', vars: {}, fix: 'recheck' },
  );

  rows.push(
    git.found
      ? { id: 'git', state: 'ok', message: git.version ? 'ok' : 'okNoVersion', vars: { version: git.version ?? '' }, fix: null }
      : { id: 'git', state: 'optional', message: 'fail', vars: {}, fix: 'installGit' },
  );

  const gb = result.diskFreeGb;
  if (gb === null) rows.push({ id: 'disk', state: 'unknown', message: 'unknown', vars: {}, fix: 'recheck' });
  else if (gb < LOW_DISK_GB) rows.push({ id: 'disk', state: 'fail', message: 'low', vars: { gb: formatGb(gb, options.locale) }, fix: 'freeDisk' });
  else rows.push({ id: 'disk', state: 'ok', message: 'ok', vars: { gb: formatGb(gb, options.locale) }, fix: null });

  if (options.showPort && result.port !== null) {
    rows.push({ id: 'port', state: 'ok', message: 'ok', vars: { port: result.port }, fix: null });
  }

  if (result.writableProjectDir === true) rows.push({ id: 'folder', state: 'ok', message: 'ok', vars: {}, fix: null });
  else if (result.writableProjectDir === false) rows.push({ id: 'folder', state: 'fail', message: 'fail', vars: {}, fix: 'chooseFolder' });

  return rows;
}

/** One decimal in the reader's locale; the message adds the unit. */
export function formatGb(gb: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gb);
}

/* -------------------------------------------------------- diagnose text */

const USER_PATH = /([A-Za-z]:\\Users\\|\/Users\/|\/home\/)([^\\/\s"']+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_SECRET = /\b(?:sk|pk|rk|nvapi|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g;

/** Removes user names in paths, e-mail addresses and anything shaped like a key. */
export function redactDiagnosis(text: string): string {
  return text
    .replace(USER_PATH, (_match, prefix: string) => `${prefix}<gebruiker>`)
    .replace(EMAIL, '<e-mailadres>')
    .replace(LONG_SECRET, '<sleutel weggehaald>');
}

/** The plain-text report behind "Diagnose kopiëren", already redacted. Lines are short facts. */
export function buildDiagnosisText(
  result: CheckupResult,
  rows: readonly CheckRow[],
  describe: (row: CheckRow) => string,
  context: Readonly<Record<string, string>>,
): string {
  const marks: Record<CheckState, string> = { ok: '[ok]', fail: '[x]', optional: '[-]', unknown: '[?]' };
  const lines = [
    'Forge Systeem - diagnose',
    ...Object.entries(context).map(([key, value]) => `${key}: ${value}`),
    `checked_at: ${result.checkedAt ?? 'onbekend'}`,
    `duration_ms: ${result.durationMs ?? 'onbekend'}`,
    `timed_out: ${String(result.timedOut)}`,
    '',
    ...rows.map((row) => `${marks[row.state]} ${describe(row)}`),
    `ollama_models: ${result.ollama.models.length > 0 ? result.ollama.models.join(', ') : '-'}`,
  ];
  return redactDiagnosis(lines.join('\n'));
}
