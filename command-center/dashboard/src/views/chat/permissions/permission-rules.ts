/**
 * The fixed rule table behind a permission card's first line (WP B3, plan §4.4).
 *
 * The summary is derived from `tool_name` + `input` by plain rules in this file, never by the
 * model: a model-written summary could understate what a command does, and the card is exactly
 * where that must not happen. The raw command is always available under "Technische details".
 *
 * Output is i18n-ready: a message key under `chatCards.permissions.summary` plus its variables,
 * the badges ("gebruikt internet" / "verwijdert iets" / "buiten deze map") and the technical text.
 *
 * Badges are the UNION of this table and the gateway's own `categories` on the pending row
 * (network -> internet, delete -> deletes, outside_folder -> outside), so the card never warns less
 * than the gateway does. A shell started inside a shell (`bash -c "..."`, `powershell -Command ...`,
 * `cmd /c ...`) is judged by the commands it runs, not by the word "bash".
 */

import type { PendingPermission } from './permission-types';

export type PermissionBadge = 'internet' | 'deletes' | 'outside';

export type SummaryKind =
  | 'download'
  | 'runRemote'
  | 'fetchWeb'
  | 'publish'
  | 'commit'
  | 'discard'
  | 'cleanUntracked'
  | 'deleteOne'
  | 'deleteMany'
  | 'deleteFolder'
  | 'projectScript'
  | 'command'
  | 'writeFile'
  | 'editFile'
  | 'readFile'
  | 'searchFiles'
  | 'webPage'
  | 'webSearch'
  | 'connection'
  | 'helper'
  | 'other';

export interface PermissionDescription {
  readonly kind: SummaryKind;
  /** Variables for `chatCards.permissions.summary.<kind>`. */
  readonly vars: Readonly<Record<string, string | number>>;
  /** Further commands in a chained shell line (`a && b && c` -> 2). */
  readonly moreCommands: number;
  readonly badges: readonly PermissionBadge[];
  /** What Claude Code actually asked for, shown under "Technische details". */
  readonly technical: string;
}

/* ------------------------------------------------------------------ helpers */

const SHORT_MAX = 60;
const TECHNICAL_MAX = 2000;
const BADGE_ORDER: readonly PermissionBadge[] = ['deletes', 'internet', 'outside'];

function short(text: string, max = SHORT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Last path segment, for "index.html" instead of "C:\\...\\site\\index.html". */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Lower-cased, forward-slashed, `.`/`..` collapsed. Git-Bash style `/c/Users` becomes `c:/users`.
 * Returns null for a relative path when there is no base to resolve it against.
 */
export function normalizePath(path: string, base?: string | null): string | null {
  let p = path.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (p === '') return null;
  const gitBash = /^\/([a-zA-Z])(\/|$)/.exec(p);
  if (gitBash) p = `${gitBash[1]}:/${p.slice(3)}`;
  const absolute = /^[a-zA-Z]:\//.test(p) || /^[a-zA-Z]:$/.test(p) || p.startsWith('//') || p.startsWith('/');
  if (!absolute) {
    if (!base) return null;
    const root = normalizePath(base);
    if (root === null) return null;
    p = `${root}/${p}`;
  }
  const out: string[] = [];
  for (const segment of p.toLowerCase().split('/')) {
    if (segment === '' || segment === '.') {
      if (out.length === 0) out.push('');
      continue;
    }
    if (segment === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/').replace(/^\/(?=[a-z]:)/, '');
}

/** True when `path` resolves outside `projectDir`. Unknown (no project folder, relative path) = false. */
export function isOutside(path: string, projectDir: string | null | undefined): boolean {
  if (!projectDir) return /^~([\\/]|$)/.test(path.trim());
  if (/^~([\\/]|$)/.test(path.trim())) return true;
  const root = normalizePath(projectDir);
  const target = normalizePath(path, projectDir);
  if (root === null || target === null) return false;
  return target !== root && !target.startsWith(`${root}/`);
}

/** Splits a shell line into its commands (`&&`, `||`, `;`, `|`, newline), quotes respected. */
export function splitCommands(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== '');
}

/** Words of one command, quotes removed. */
export function words(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3] ?? '');
  return out;
}

function programName(word: string): string {
  return baseName(word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

const isFlag = (word: string) => /^-{1,2}[A-Za-z]/.test(word) || /^\/[a-zA-Z]$/.test(word);

/**
 * Only the real "everything below it too" flags: -r, -R, a short cluster with r and f/v/i (-rf,
 * -fr, -Rfv), --recursive, PowerShell -Recurse, cmd /s. Not every flag that happens to contain an r
 * (`-Force`, `-Verbose`), which made `Remove-Item -Force file.txt` read as a folder delete.
 */
export function isRecursiveFlag(word: string): boolean {
  return /^-[fvi]*[rR][fvi]*$/i.test(word) && word.length <= 4 ? true : /^(--recursive|-recurse|\/s)$/i.test(word);
}

/** Gateway categories (contract §"Gateway side as built") -> card badges. Unknown ones are ignored. */
const CATEGORY_BADGE: Readonly<Record<string, PermissionBadge>> = {
  network: 'internet',
  delete: 'deletes',
  outside_folder: 'outside',
};

function categoryBadges(categories: unknown): PermissionBadge[] {
  if (!Array.isArray(categories)) return [];
  const out: PermissionBadge[] = [];
  for (const category of categories) {
    if (typeof category === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_BADGE, category)) out.push(CATEGORY_BADGE[category]);
  }
  return out;
}

/* ------------------------------------------------------------------ nested shells */

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const NESTING_MAX = 3;

/** Leading `FOO=bar` assignments and `sudo` do not change what the command is. */
function stripPrefix(list: string[]): string[] {
  let out = list;
  while (out.length > 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || out[0] === 'sudo')) out = out.slice(1);
  return out;
}

/** The command string a shell wrapper runs (`bash -c "x"` -> `x`), or null when it is not a wrapper. */
export function innerShellCommand(command: string): string | null {
  const list = stripPrefix(words(command));
  const program = programName(list[0] ?? '');
  const args = list.slice(1);
  if (POSIX_SHELLS.has(program)) {
    const at = args.findIndex((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
    return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
  }
  if (POWERSHELLS.has(program)) {
    const at = args.findIndex((word) => /^-(c|command)$/i.test(word));
    return at >= 0 && at + 1 < args.length ? args.slice(at + 1).join(' ') : null;
  }
  if (program === 'cmd') {
    const at = args.findIndex((word) => /^\/[ck]$/i.test(word));
    return at >= 0 && at + 1 < args.length ? args.slice(at + 1).join(' ') : null;
  }
  return null;
}

/** Splits a line into commands and replaces every shell wrapper by the commands inside it. */
function expandCommands(line: string, depth = 0): string[] {
  const out: string[] = [];
  for (const command of splitCommands(line)) {
    const inner = depth < NESTING_MAX ? innerShellCommand(command) : null;
    const expanded = inner === null ? [] : expandCommands(inner, depth + 1);
    if (expanded.length > 0) out.push(...expanded);
    else out.push(command);
  }
  return out;
}

/* ------------------------------------------------------------------ shell rules */

interface CommandVerdict {
  readonly kind: SummaryKind;
  readonly vars: Readonly<Record<string, string | number>>;
  readonly badges: readonly PermissionBadge[];
  readonly weight: number;
  readonly paths: readonly string[];
}

const DELETE_PROGRAMS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink', 'shred']);
const INSTALL_WORDS = new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade', 'get', 'restore', 'sync']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const OTHER_INSTALLERS = new Set(['pip', 'pip3', 'uv', 'poetry', 'pipx', 'winget', 'choco', 'scoop', 'cargo', 'go', 'composer', 'gem', 'dotnet', 'brew', 'apt', 'apt-get']);
const WEB_FETCHERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
const REMOTE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PUBLISHERS = new Set(['vercel', 'netlify', 'firebase', 'wrangler', 'flyctl', 'fly']);
const NETWORK_TOOLS = new Set(['gh', 'ssh', 'scp', 'rsync', 'ftp', 'sftp']);
const NAVIGATION = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);

function classifyCommand(command: string): CommandVerdict {
  const list = stripPrefix(words(command));
  const program = programName(list[0] ?? '');
  const args = list.slice(1);
  const operands = args.filter((word) => !isFlag(word));
  const pathLike = operands.filter((word) => /[\\/]|^\.\.?$|^~|\.[A-Za-z0-9]{1,5}$/.test(word));
  const generic: CommandVerdict = { kind: 'command', vars: { short: short(command) }, badges: [], weight: 1, paths: pathLike };

  if (DELETE_PROGRAMS.has(program)) {
    const targets = operands.filter((word) => !/^-(path|literalpath)$/i.test(word));
    const recursive = program === 'rmdir' || program === 'rd' || args.some(isRecursiveFlag);
    const base = { badges: ['deletes'] as PermissionBadge[], weight: 5, paths: targets };
    if (targets.length === 0) return { ...generic, badges: ['deletes'], weight: 5 };
    if (recursive) return { ...base, kind: 'deleteFolder', vars: { name: baseName(targets[0]) } };
    if (targets.length === 1) return { ...base, kind: 'deleteOne', vars: { name: baseName(targets[0]) } };
    const shown = targets.slice(0, 3).map(baseName).join(', ');
    return { ...base, kind: 'deleteMany', vars: { count: targets.length, names: targets.length > 3 ? `${shown}, …` : shown } };
  }

  if (program === 'git') {
    const sub = (operands[0] ?? '').toLowerCase();
    if (sub === 'push') return { kind: 'publish', vars: { tool: 'git push' }, badges: ['internet'], weight: 4, paths: [] };
    if (sub === 'clone' || sub === 'pull' || sub === 'fetch')
      return { kind: 'fetchWeb', vars: { tool: `git ${sub}` }, badges: ['internet'], weight: 3, paths: operands.slice(1).filter((w) => !/^[a-z]+:\/\//i.test(w) && !/^git@/.test(w)) };
    if (sub === 'commit') return { kind: 'commit', vars: { tool: 'git commit' }, badges: [], weight: 2, paths: [] };
    if (sub === 'rm') return { ...generic, badges: ['deletes'], weight: 5 };
    if (sub === 'clean') return { kind: 'cleanUntracked', vars: { tool: 'git clean' }, badges: ['deletes'], weight: 5, paths: [] };
    const discard = { kind: 'discard' as const, vars: { tool: `git ${sub}` }, badges: ['deletes'] as PermissionBadge[], weight: 5, paths: [] };
    const gitArgs = args.slice(args.findIndex((word) => word.toLowerCase() === sub) + 1);
    // `git reset --hard` throws away every unsaved change; a soft/mixed reset keeps the files.
    if (sub === 'reset') return gitArgs.some((word) => /^--(hard|merge|keep)$/.test(word)) ? discard : { ...generic, weight: 2 };
    // `git checkout -- <path>` / `git checkout .` overwrite files; `git checkout main` switches branch.
    if (sub === 'checkout') return gitArgs.includes('--') || gitArgs.includes('.') || gitArgs.some((w) => /^(-f|--force)$/.test(w)) ? discard : { ...generic, weight: 2 };
    // `git restore <path>` overwrites the working copy; only `--staged` without `--worktree` does not.
    if (sub === 'restore') {
      const stagedOnly = gitArgs.some((w) => w === '--staged' || w === '-S') && !gitArgs.some((w) => w === '--worktree' || w === '-W');
      return stagedOnly ? { ...generic, weight: 2 } : discard;
    }
    return generic;
  }

  if (PACKAGE_MANAGERS.has(program)) {
    const sub = (operands[0] ?? '').toLowerCase();
    if (INSTALL_WORDS.has(sub) || (program === 'yarn' && operands.length === 0))
      return { kind: 'download', vars: { tool: program }, badges: ['internet'], weight: 3, paths: [] };
    if (sub === 'publish') return { kind: 'publish', vars: { tool: `${program} publish` }, badges: ['internet'], weight: 4, paths: [] };
    if (sub === 'exec' || sub === 'dlx' || sub === 'x')
      return { kind: 'runRemote', vars: { tool: `${program} ${sub}` }, badges: ['internet'], weight: 3, paths: [] };
    if (sub === 'remove' || sub === 'uninstall' || sub === 'rm' || sub === 'un')
      return { ...generic, badges: ['deletes'], weight: 4, paths: [] };
    return { kind: 'projectScript', vars: { name: short(list.join(' '), 40) }, badges: [], weight: 1, paths: [] };
  }

  if (REMOTE_RUNNERS.has(program)) return { kind: 'runRemote', vars: { tool: program }, badges: ['internet'], weight: 3, paths: [] };

  if (OTHER_INSTALLERS.has(program)) {
    const sub = (operands[0] ?? '').toLowerCase();
    if (INSTALL_WORDS.has(sub)) return { kind: 'download', vars: { tool: program }, badges: ['internet'], weight: 3, paths: [] };
    if (sub === 'uninstall' || sub === 'remove') return { ...generic, badges: ['deletes'], weight: 4, paths: [] };
    return generic;
  }

  if (WEB_FETCHERS.has(program))
    return { kind: 'fetchWeb', vars: { tool: program }, badges: ['internet'], weight: 3, paths: operands.filter((w) => !/^[a-z]+:\/\//i.test(w)) };

  if (PUBLISHERS.has(program)) return { kind: 'publish', vars: { tool: program }, badges: ['internet'], weight: 4, paths: [] };
  if (NETWORK_TOOLS.has(program)) return { ...generic, badges: ['internet'], weight: 3, paths: [] };
  if (NAVIGATION.has(program)) return { ...generic, weight: 0 };
  return generic;
}

/* ------------------------------------------------------------------ public */

function technicalText(request: PendingPermission): string {
  const command = str(request.input.command);
  const text = command !== '' ? command : `${request.tool_name}\n${JSON.stringify(request.input, null, 2)}`;
  return text.length > TECHNICAL_MAX ? `${text.slice(0, TECHNICAL_MAX)}\n…` : text;
}

function sortBadges(badges: Iterable<PermissionBadge>): PermissionBadge[] {
  const set = new Set(badges);
  return BADGE_ORDER.filter((badge) => set.has(badge));
}

function describeShell(request: PendingPermission, projectDir: string | null | undefined): PermissionDescription {
  const commands = expandCommands(str(request.input.command));
  if (commands.length === 0) {
    return { kind: 'command', vars: { short: '' }, moreCommands: 0, badges: [], technical: technicalText(request) };
  }
  const verdicts = commands.map(classifyCommand);
  // The heaviest command names the card; ties go to the first one, which is what reads naturally.
  const lead = verdicts.reduce((best, next) => (next.weight > best.weight ? next : best), verdicts[0]);
  const badges = new Set<PermissionBadge>(verdicts.flatMap((verdict) => verdict.badges));
  if (verdicts.some((verdict) => verdict.paths.some((path) => isOutside(path, projectDir)))) badges.add('outside');
  // `cd` lines and the like are not worth a "plus one more" line.
  const counted = verdicts.filter((verdict) => verdict.weight > 0).length;
  return {
    kind: lead.kind,
    vars: lead.vars,
    moreCommands: Math.max(0, counted - 1),
    badges: sortBadges(badges),
    technical: technicalText(request),
  };
}

function describeTool(request: PendingPermission, projectDir: string | null | undefined): PermissionDescription {
  const input = request.input;
  const tool = request.tool_name;
  const filePath = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const outside = filePath !== '' && isOutside(filePath, projectDir);
  const base = (kind: SummaryKind, vars: Record<string, string | number>, badges: PermissionBadge[] = []): PermissionDescription => ({
    kind,
    vars,
    moreCommands: 0,
    badges: sortBadges(outside ? [...badges, 'outside'] : badges),
    technical: technicalText(request),
  });

  switch (tool) {
    case 'Write':
      return base('writeFile', { name: baseName(filePath) });
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base('editFile', { name: baseName(filePath) });
    case 'Read':
      return base('readFile', { name: baseName(filePath) });
    case 'Glob':
    case 'Grep':
      return base('searchFiles', { name: short(str(input.pattern) || filePath, 40) });
    case 'WebFetch': {
      let host = str(input.url);
      try {
        host = new URL(host).host;
      } catch {
        host = short(host, 40);
      }
      return base('webPage', { name: host }, ['internet']);
    }
    case 'WebSearch':
      return base('webSearch', { name: short(str(input.query), 50) }, ['internet']);
    case 'Task':
    case 'Agent':
      return base('helper', { name: short(str(input.description) || str(input.subagent_type), 50) });
    default:
      break;
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (mcp) return base('connection', { name: mcp[1] });
  return base('other', { name: tool });
}

/** The card's first line, badges and technical text for one request. */
export function describePermission(request: PendingPermission, projectDir?: string | null): PermissionDescription {
  const own = request.tool_name === 'Bash' || request.tool_name === 'PowerShell' ? describeShell(request, projectDir) : describeTool(request, projectDir);
  const fromGateway = categoryBadges(request.categories);
  if (fromGateway.length === 0) return own;
  return { ...own, badges: sortBadges([...own.badges, ...fromGateway]) };
}
