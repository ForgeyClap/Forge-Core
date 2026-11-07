// Forge gateway — permission rule table (WP B3, plan 4.4).
//
// A FIXED table (never the model) that turns one Claude Code permission request (`tool_name` +
// `input`) into:
//   - categories: a subset of network | delete | outside_folder | exec | edit (the badges);
//   - summary_nl: one plain-Dutch line, used for the Windows notification text and as the optional
//     `summary_nl` field of the contract (_scratch/b3/contract-permissions.md). The dashboard keeps
//     its OWN table for the card's first line; the category names here are the shared vocabulary.
//   - a session rule key: what "Altijd toestaan in dit gesprek" remembers. An ALLOW-LIST: WebSearch,
//     WebFetch by origin (host:port, never this machine's gateway), and the gateway's own forge-ask
//     tool. Null for every shell, edit, read and unknown tool (see the SAFETY RULE above sessionRuleKey).
//
// Pure functions only: no I/O, no clock. Every input is untrusted (it comes from the model through
// the CLI), so every field is type-checked before use and nothing here ever throws.
import path from 'node:path';
import { getGatewayPort, DEFAULT_GATEWAY_PORT, configuredGatewayPort } from '../runtime-state.mjs';

export const PERMISSION_CATEGORIES = Object.freeze(['network', 'delete', 'outside_folder', 'exec', 'edit']);

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

// Package managers: <word> + a subcommand that downloads. The label is the word shown in Dutch copy.
const PACKAGE_DOWNLOADS = [
  { word: 'npm', subs: ['install', 'i', 'ci', 'add', 'update', 'exec'] },
  { word: 'npx', subs: null },
  { word: 'pnpm', subs: ['install', 'i', 'add', 'update', 'dlx'] },
  { word: 'yarn', subs: ['install', 'add', 'upgrade', 'dlx'] },
  { word: 'bun', subs: ['install', 'i', 'add', 'x'] },
  { word: 'pip', subs: ['install', 'download'] },
  { word: 'pip3', subs: ['install', 'download'] },
  { word: 'uv', subs: ['add', 'pip', 'sync', 'tool'] },
  { word: 'winget', subs: ['install', 'upgrade'] },
  { word: 'choco', subs: ['install', 'upgrade'] },
];
const NETWORK_WORDS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'ftp']);
const GIT_NETWORK_SUBS = new Set(['clone', 'pull', 'push', 'fetch']);
const DELETE_WORDS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink', 'shred']);

const MAX_COMMAND_CHARS = 8000;

function str(v) {
  return typeof v === 'string' ? v : '';
}

function stripQuotes(token) {
  return token.replace(/^['"]+|['"]+$/g, '');
}

/** Splits a shell command into segments (&&, ||, ;, |, newline) and each segment into tokens.
 *  A heuristic for labelling only: it never decides whether anything runs. */
export function shellSegments(command) {
  const text = str(command).slice(0, MAX_COMMAND_CHARS);
  return text
    .split(/&&|\|\||;|\||\r?\n/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean).map(stripQuotes).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

function firstWord(tokens) {
  // `sudo x`, `env A=1 x`, `& x` (PowerShell call operator) -> x
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === '&' || tokens[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  const word = tokens[i] || '';
  return { word: path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, ''), rest: tokens.slice(i + 1) };
}

function packageDownload(word, rest) {
  for (const pm of PACKAGE_DOWNLOADS) {
    if (pm.word !== word) continue;
    if (pm.subs === null) return pm.word;
    const sub = (rest.find((t) => !t.startsWith('-')) || '').toLowerCase();
    if (pm.subs.includes(sub)) return pm.word;
  }
  return null;
}

function isAbsolutePathToken(token) {
  return /^[A-Za-z]:[\\/]/.test(token) || (token.startsWith('/') && token !== '/dev/null' && !token.startsWith('//'));
}

function insideFolder(cwd, target) {
  if (!cwd || !target) return true;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function deleteTargets(rest) {
  return rest.filter((t) => !t.startsWith('-') && !/^-{1,2}[A-Za-z]/.test(t));
}

// ---- Gateway-self detection (Security Boss decision 1b, second half: honest card copy) -----------
// A call that reaches THIS machine's Forge gateway (its served HTML carries the dashboard token, its
// API answers permission cards) is labelled "Bedient Forge zelf" instead of "iets ophalen van internet".
// It is copy only; the key rules below never remember such a call anyway.

/** Every port a Forge gateway on this machine may answer on: the live one, the default and the pinned one.
 *  Residual (review note 2026-11-02): a SIBLING gateway that fell back to another port (runtime-state.mjs
 *  side-by-side layout) is not known here, so a fetch to it gets the plain copy and a plain origin key;
 *  that key never reaches beyond the origin the user approved once. */
function gatewayPorts() {
  const ports = new Set([String(DEFAULT_GATEWAY_PORT)]);
  try { ports.add(String(getGatewayPort())); } catch { /* no runtime state: default only */ }
  try { const pinned = configuredGatewayPort(); if (pinned) ports.add(String(pinned)); } catch { /* unreadable env */ }
  return ports;
}

const GATEWAY_API_RE = /^\/api\/(permissions|ask|conversations|config|projects)(\/|$)/;

/** True when `url` is an http(s) URL on a loopback host AND a gateway port of this machine. The card copy
 *  uses only this (a dev app on another port may have its own /api/config); webFetchKey additionally
 *  refuses a key for a gateway API PATH on any loopback port, as defence in depth. */
function isGatewaySelfUrl(url) {
  let u;
  try { u = new URL(str(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!isLoopbackHost(u.hostname)) return false;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return gatewayPorts().has(port);
}

/** True when a shell command names the gateway: a loopback gateway URL or the dashboard token header. */
function namesGatewaySelf(tokens) {
  return tokens.some((t) => /x-cc-exec-token/i.test(t) || isGatewaySelfUrl(t.replace(/^[\[(<"']+|[\])>"',;]+$/g, '')));
}

function classifyShell(command, cwd) {
  const categories = new Set(['exec']);
  let summary = null;
  for (const tokens of shellSegments(command)) {
    const { word, rest } = firstWord(tokens);
    const pm = packageDownload(word, rest);
    if (pm) {
      categories.add('network');
      summary = summary || 'Programmaonderdelen downloaden van internet (' + pm + ')';
    }
    if (word === 'git') {
      const sub = (rest.find((t) => !t.startsWith('-')) || '').toLowerCase();
      if (GIT_NETWORK_SUBS.has(sub)) {
        categories.add('network');
        summary = summary || (sub === 'push' ? 'Code naar internet sturen (git push)' : 'Code ophalen van internet (git ' + sub + ')');
      }
      if (sub === 'clean' || (sub === 'reset' && rest.includes('--hard'))) {
        categories.add('delete');
        summary = summary || 'Niet-opgeslagen wijzigingen weggooien (git ' + sub + ')';
      }
    }
    if (NETWORK_WORDS.has(word)) {
      categories.add('network');
      summary = summary || 'Iets ophalen van internet (' + word + ')';
    }
    if (DELETE_WORDS.has(word)) {
      categories.add('delete');
      const targets = deleteTargets(rest);
      if (!summary) {
        summary = targets.length === 1
          ? '1 bestand verwijderen: ' + path.basename(targets[0].replace(/\\/g, '/'))
          : targets.length + ' bestanden verwijderen';
      }
    }
    if (cwd && tokens.some((t) => isAbsolutePathToken(t) && !insideFolder(cwd, t))) categories.add('outside_folder');
  }
  const first = shellSegments(command)[0];
  if (!summary) summary = 'Een opdracht uitvoeren: ' + (first ? firstWord(first).word || first[0] : 'onbekend');
  if (shellSegments(command).some(namesGatewaySelf)) {
    // A self-contained sentence, not a prefix: the call never leaves this computer.
    const program = first ? firstWord(first).word || first[0] : 'onbekend';
    summary = 'Bedient Forge zelf: de Forge-gateway op deze computer aanspreken (' + program + ')';
  }
  return { categories, summary };
}

function filePathOf(input) {
  return str(input.file_path) || str(input.notebook_path) || str(input.path);
}

function hostOf(url) {
  try {
    return new URL(str(url)).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Classifies one permission request. `cwd` (optional) is the conversation's project folder; with
 * it, a path outside that folder adds `outside_folder`.
 * @returns {{ categories: string[], summary_nl: string }}
 */
export function classifyPermission(toolName, input, { cwd = null } = {}) {
  const name = str(toolName);
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let categories = new Set();
  let summary;

  if (SHELL_TOOLS.has(name)) {
    const shell = classifyShell(inp.command, cwd);
    categories = shell.categories;
    summary = shell.summary;
  } else if (EDIT_TOOLS.has(name)) {
    categories.add('edit');
    const file = path.basename(filePathOf(inp).replace(/\\/g, '/')) || 'onbekend';
    summary = name === 'Write' ? 'Een bestand maken of overschrijven: ' + file : 'Een bestand aanpassen: ' + file;
  } else if (NETWORK_TOOLS.has(name)) {
    categories.add('network');
    if (name === 'WebSearch') summary = 'Op internet zoeken';
    else if (isGatewaySelfUrl(inp.url)) summary = 'Bedient Forge zelf: een pagina van de Forge-gateway op deze computer openen (' + hostOf(inp.url) + ')';
    else summary = 'Een webpagina openen: ' + (hostOf(inp.url) || 'onbekend adres');
  } else if (READ_TOOLS.has(name)) {
    const file = filePathOf(inp);
    summary = file ? 'Een bestand lezen: ' + path.basename(file.replace(/\\/g, '/')) : 'Bestanden doorzoeken';
  } else {
    summary = 'Een hulpmiddel gebruiken: ' + (name || 'onbekend');
  }

  const file = filePathOf(inp);
  if (cwd && file && path.isAbsolute(file) && !insideFolder(cwd, file)) categories.add('outside_folder');

  return {
    categories: PERMISSION_CATEGORIES.filter((c) => categories.has(c)),
    summary_nl: summary,
  };
}

// ---------------------------------------------------------------------------------------------
// Session rule key ("Altijd toestaan in dit gesprek").
//
// SAFETY RULE: a key may only exist for a call that no LATER call with the same key can widen.
// Lead decision 2026-11-02 (after two Review Boss FAILs on a shell whitelist): a Bash or PowerShell
// command is NEVER remembered. A shell string can always carry more than its first word shows (an
// option with a glued path such as -Path:<home>\.ssh\id_rsa, a sed script that runs a command), so
// the allow-list for shells is empty by construction: every shell call is allowed once and asked
// again next time. classifyPermission() above still labels shell calls for the card; it never
// decides what is remembered. For the other tools a call in the delete or outside_folder category
// never gets a key, every edit and read tool returns null (see sessionRuleKey), and the sorted
// category list is part of every key.
// ---------------------------------------------------------------------------------------------

const NEVER_REMEMBERED_CATEGORIES = new Set(['delete', 'outside_folder']);


// Loopback host names as the WHATWG URL parser (Node's `new URL`) hands them back. The parser already
// normalises 127.1, 127.0.1, 2130706433, 0x7f000001 and a trailing-dot 127.0.0.1 to '127.0.0.1', and
// every IPv6 spelling of ::1 to '[::1]' (brackets kept); the IPv4-mapped form comes back as
// '[::ffff:7f00:1]'. DNS names that resolve to loopback (localtest.me, *.nip.io) are NOT recognised
// here: the gateway refuses them itself, because server.mjs hostOk() answers only the Host names in
// security.mjs LOCAL_HOSTS. That check, not this list, is the backstop for the token-bearing HTML.
const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return LOOPBACK_HOSTS.has(h)
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
    || /^\[?(0*:)+0*1\]?$/.test(h)
    || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\]$/.test(h);
}

/** The WebFetch key: the normalised origin (host:port), or null when the fetch could reach this gateway. */
function webFetchKey(url) {
  let u;
  try { u = new URL(str(url)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = (u.hostname || '').toLowerCase();
  if (!host) return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (isLoopbackHost(host)) {
    // Security Boss decision 1b: the served HTML carries the dashboard token, so no gateway origin on
    // this machine is ever remembered: not the live port, not the default 4100 (after a port fallback
    // another Forge gateway may own it) and not a pinned port; nor any loopback URL naming the gateway API.
    if (gatewayPorts().has(port)) return null;
    if (GATEWAY_API_RE.test(u.pathname)) return null;
  }
  return host + ':' + port;
}

/** The gateway's own MCP tools, by exact name (permission_prompt is the prompt itself and is never prompted). */
const FORGE_ASK_TOOLS = new Set(['mcp__forge-ask__ask_owner']);

/**
 * The key "Altijd toestaan in dit gesprek" stores, or null when this call must never be remembered.
 * ALLOW-LIST (Lead, after the independent sign-off): WebSearch; WebFetch by ORIGIN
 * (host:port, never a gateway origin on this machine); the forge-ask tool. Every shell, edit, read
 * and unknown tool returns null. The sorted category list is part of every key. `cwd` is the
 * conversation's project folder (the same one classifyPermission gets).
 */
export function sessionRuleKey(toolName, input, options) {
  try {
    const name = str(toolName);
    if (!name) return null;
    const cwd = options && typeof options === 'object' ? options.cwd : null;
    const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const folder = typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
    const { categories } = classifyPermission(name, inp, { cwd: folder });
    if (categories.some((c) => NEVER_REMEMBERED_CATEGORIES.has(c))) return null;
    const suffix = ' [' + [...categories].sort().join(',') + ']';
    // ALLOW-LIST: only tools whose whole effect the key captures.
    if (name === 'WebSearch') return name + suffix;
    if (name === 'WebFetch') {
      const origin = webFetchKey(inp.url);
      return origin ? 'WebFetch:' + origin + suffix : null;
    }
    if (FORGE_ASK_TOOLS.has(name)) return name + suffix;
    // Never remembered: shell tools; Monitor/Task-like tools; every edit tool AND every read tool
    // (Read, Glob, Grep, LS). Claude Code reads and edits inside the project folder without asking, so
    // an in-folder card for one of these exists only because that file or pattern was gated on purpose
    // (an ask rule, a path that resolves outside through a junction); a key by tool name would let one
    // grant cover every other gated file (sign-off finding). Unknown tools: never remembered.
    return null;
  } catch {
    return null; // never throw on model input; no key = ask again
  }
}
