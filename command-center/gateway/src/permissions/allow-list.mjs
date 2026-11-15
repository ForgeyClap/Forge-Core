// Forge gateway: the ALLOW-LIST for permission cards (WP-AUTONOMY-GW fix round 2, security review
// rv-autonomy-sec-2). With autonomy on, a card is approved without the owner only when this file can
// prove it safe:
//   - a read-only tool (Read, Grep, Glob, LS, NotebookRead) that names no credential file or network share;
//   - an edit (Write, Edit, MultiEdit, NotebookEdit) whose real location is inside the project, outside
//     .git and node_modules, and not a protected file (settings, hooks, gate code, credentials);
//   - a shell command (Bash or PowerShell) made only of the known programs below with simple literal
//     arguments, read by a strict reader that refuses everything it does not fully understand:
//     variables, substitutions, back-ticks, PowerShell expressions and script blocks, wrappers
//     (bash -c, pwsh -c, cmd /c, env), background jobs, unquoted heredocs, a working folder outside
//     the project, a write outside the project, a script it has not inspected.
// Everything else waits for the owner. hard-gate.mjs calls allowListed() after its own block list, which
// names the reason of a known hard gate (push, deploy, delete, ...); both must agree before a card is
// approved without asking. Pure apart from read-only checks: the package.json that `npm test` or
// `npm run` would use, node_modules/.bin for `npx`, the folder a bash wildcard is expanded in, and
// what hard-gate.mjs looks up for a read target (h.readProblem).
//
// Reads (escalation round). Four reviews beat a read gate that judged the NAME in the card
// (an 8.3 short name, a wildcard, a search started one folder up, a link). The rule is structural now:
//   - every path a reading program or tool is given is judged at its REAL location: inside the project
//     or the OS temp folder, not a sensitive file; a read outside both asks (this knowingly narrows
//     owner choice R-0203); a path part that looks like a short name (`~1`) asks;
//   - a program that prints file text (cat, grep, sed, Get-Content, ...) given a folder, or a search
//     (grep -r, rg, the Grep and Glob tools, Get-ChildItem piped into Select-String), is approved only
//     when no sensitive file can be reached below that folder (a bounded walk; too big = ask);
//   - a wildcard asks unless every file it can expand to passes (bash: expanded here as a superset;
//     PowerShell, package scripts and the path inputs of Read/Grep: always ask);
//   - git prints file text too: a patch (diff, show, log -p, blame) needs named ordinary paths or a
//     repository without a reachable sensitive file; an object id may be a blob and asks; a `REV:path`
//     needs a path without `..` in a repository whose top is inside the project.
// Round 5 also took Get-Command off the PowerShell list (it prints script text) and narrowed
// Get-Process to its default table (a process object carries its command line in PowerShell 7).
// A lister (ls, find, Get-ChildItem, the Glob tool on its own) shows names and sizes only.
//
// Documented limit (the owner-facing text has to say it): a test runner or build (node --test, vitest,
// tsc --noEmit, vite build, eslint, and the package scripts read here) runs the project's own code and
// config. Forge reads what a command says; it does not sandbox what the project's code then does.
// Verify round 6: after a routine step wrote code in the project (h.codeWritten) those runners ask
// ('wrote_code'); `which` and bash `type` ask; git ls-files/ls-tree/status names stay inside the project;
// a PowerShell word that starts with a quote and goes on after it is 'unjudgeable'.
// Verify round 8: an Agent or Task call is proven safe only with known fields (dispatchAllowed); a WebSearch only
// when its query carries no address, token or secret (webSearchProblem); a runner names its family (runnerFamily),
// and h.codeWritten may be a function of that family (approving one runner clears only its own family).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../redact.mjs';

const MAX_CHARS = 8000;
const MAX_BASES = 8;
const MAX_DEPTH = 3; // npm script -> npm script -> ...
const WIN = process.platform === 'win32';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Tools whose effect stays inside Claude Code itself; their own tool calls come back as cards. Agent, Task and
// WebSearch are on it only with the inputs proven below.
const SAFE_TOOLS = new Set(['WebSearch', 'TodoWrite', 'Task', 'Agent', 'Skill', 'ToolSearch', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'mcp__forge-ask__ask_owner']);
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);
// a glob that may match a secret file (Glob pattern, Grep glob): `.env*`, `**/*.pem`, `.ssh/*`
const CRED_GLOB_RE = /(?:^|[\\/*.{,\s])(?:\.?env(?:$|[.*{\s])|\.env[~_-]|\.?npmrc|\.?netrc|\.?pypirc|\.git-credentials|credentials|secrets?(?:$|[\\/.*])|id_(?:rsa|dsa|ecdsa|ed25519)|\.pem|\.p12|\.pfx|\.jks|\.keystore|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker)/i;
// an argument a Windows batch shim (npm.cmd, npx.cmd, node_modules/.bin/*.cmd) passes through cmd.exe
// unchanged: no spaces, quotes, or cmd metacharacters (& | < > ^ % ! ( ) ,)
const SIMPLE_ARG_RE = /^[A-Za-z0-9_./:=@+-]+$/;
const SIMPLE_VALUE_RE = /^[A-Za-z0-9_.:@+-]+$/;
const NULL_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul']);
const KNOWN_NODE_RE = WIN
  ? /^(?:[A-Za-z]:[\\/]|\/[a-z]\/)Program Files[\\/]nodejs[\\/]node(?:\.exe)?$/i
  : /^\/usr(?:\/local)?\/bin\/node$/;

/** True when the card is provably safe. `h`: the helpers hard-gate.mjs passes in (see allowContext there). Never throws. */
export function allowListed(toolName, input, h) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !h || !h.root) return false;
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return shellFieldsOk(input) && shellAllowed(input.command, toolName === 'PowerShell', h, 0, [h.root]);
    }
    if (READ_TOOLS.has(toolName)) return readToolAllowed(toolName, input, h);
    if (EDIT_TOOLS.has(toolName)) {
      const p = str(input.file_path) || str(input.notebook_path);
      return p !== '' && !isUnc(p) && !shortNamed(p, h.root, h) && writeOk(h.locate(p, h.root), h);
    }
    // Round 7 (LOW): a WebFetch is never proven safe. Another host can carry data out in the URL; this
    // computer serves this gateway's own API (4100), the Node inspector (9229) and dev servers whose GET routes may
    // change state or hand out what the owner did not mean to share. A loopback fetch keeps hard-gate.mjs's
    // 'routine' (no named gate) and waits as not_allowlisted.
    if (toolName === 'WebFetch') return false;
    if (DISPATCH_TOOLS.has(toolName)) return dispatchAllowed(input, h);
    if (toolName === 'WebSearch' && webSearchProblem(input)) return false;
    return SAFE_TOOLS.has(toolName);
  } catch {
    return false;
  }
}

// Round 8 (F1, the probe's shell shapes): a shell card is read in the run folder with Claude Code's own fields only. A
// `cwd`, a sandbox switch that is on, or any field Forge does not know could change where or how the command runs.
const SHELL_FIELDS = Object.freeze({
  command: (v) => typeof v === 'string', description: (v) => typeof v === 'string', timeout: (v) => typeof v === 'number' && Number.isFinite(v),
  run_in_background: (v) => typeof v === 'boolean', dangerouslyDisableSandbox: (v) => v === false,
});
const shellFieldsOk = (input) => ownFields(input).every(([k, v]) => Object.hasOwn(SHELL_FIELDS, k) && SHELL_FIELDS[k](v));

/** Round 9 (probe a1): every own field of a card's input, with null for a key that is not a plain enumerable string key (a
 *  symbol, or a field hidden from Object.entries): such an input is never proven safe. JSON never makes one. */
export function ownFields(input) {
  return Reflect.ownKeys(input).map((k) => (typeof k === 'string' && Object.prototype.propertyIsEnumerable.call(input, k) ? [k, input[k]] : [null, undefined]));
}
/** A Windows drive-relative path (`C:foo`): its folder depends on the per-drive current folder of whoever opens it. */
export const driveRelative = (v) => WIN && /^[A-Za-z]:(?![\\/])/.test(v);

// an Agent or Task call starts a subagent. Its own tool calls come back as cards, but WHERE it works and
// WITH WHAT permissions this one call decides. Proven safe: only these fields, each of its own type; `isolation` only
// 'worktree'; `cwd` only a folder whose real location (links, 8.3 short names and letter case resolved) is inside the
// run folder. A `mode`, a remote run, any other field (a path, a tool list, settings, env, a field Forge does not know)
// waits; hard-gate.mjs names the reason where it can ('settings', 'outbound', 'outside_folder').
const DISPATCH_STRINGS = new Set(['description', 'prompt', 'subagent_type', 'model', 'effort', 'name']);

function dispatchAllowed(input, h) {
  for (const [key, value] of ownFields(input)) {
    if (key === null) return false;
    if (DISPATCH_STRINGS.has(key)) { if (typeof value !== 'string') return false; continue; }
    if (key === 'run_in_background') { if (typeof value !== 'boolean') return false; continue; }
    if (key === 'isolation') { if (value !== 'worktree') return false; continue; }
    if (key === 'cwd') {
      if (typeof value !== 'string' || value === '' || isUnc(value) || winAlias(value) || driveRelative(value)) return false;
      if (h.projectRel(h.locate(value, h.root)) === null) return refuse(h, 'outside_folder');
      continue;
    }
    return false;
  }
  return true;
}

// Round 8 (LOW): a WebSearch query leaves this computer. One that holds an address (a scheme, www., a search operator
// such as site:, a host with a path, an IP address, an e-mail address), a long token-like run of letters and digits, a
// secret, or more than QUERY_MAX characters could carry data out: it asks. An ordinary question stays routine.
// the same for data hidden in a query that reads like words. The query is judged after Unicode NFKC folding
// (full-width letters and dots are the plain ones); any control, format (zero-width), private-use or unassigned
// character asks. Signs of encoded data that ask: a run of 30 or more letters or digits without a break; two or more
// 12+ character words of letters and digits; three or more words that look like hex (letters a-f and digits) or like
// base64 (both letter cases, almost no vowels), or two such words with 24 characters together; three or more percent
// escapes; four or more emoji; a query that is only a host name with a long (10+) or letters-and-digits label or 4+
// labels; a host:port; an IPv6 address. Only the fields Claude Code sends are known: query, allowed_domains,
// blocked_domains and mode ('standard' or 'extended'); any other field asks. The domain filters: at most 10 per list,
// plain host names of 2 to 5 labels of at most 24 characters, no letter case mixed inside a label, 120 characters in all.
// the data-label test (dataLabel: a hex run with a digit, or a long digit-packed run) runs per dot
// label of every host-like WORD in the query, not only on a whole-query host, and per label of each domain filter, so
// data hidden in a sub-domain such as `4f6e65.4f7468.6572.example.com resolve` or an `8 x 20-hex .com` filter asks.
// Measured on 3336 real WebSearch queries it adds no false positive; real host, file and version labels stay routine.
// Not fixable by a reader of text: data spelled as ordinary words (a code word per letter, "alpha bravo ..."), or a few
// bits per query over many queries. A WebSearch still leaves this computer; these rules make a large leak ask.
const QUERY_MAX = 400;
const QUERY_ADDRESS_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:site|inurl|intitle|intext|link|cache|related|filetype|ext):\S|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}:\d{1,5}\b/i;
const QUERY_TOKEN_RE = /[A-Za-z0-9+/_=-]{32,}/g;
const WEBSEARCH_FIELDS = new Set(['query', 'allowed_domains', 'blocked_domains', 'mode']);
const WEBSEARCH_MODES = new Set(['standard', 'extended']);
const DOMAINS_MAX = 10;
const DOMAIN_CHARS_MAX = 120; // a data channel across the filters is smaller now

/** null, or the gate code of a WebSearch whose query may carry data: 'credentials' (a secret) or 'outbound'. Never throws. */
export function webSearchProblem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'outbound';
  for (const [key, value] of ownFields(input)) {
    if (key === null || !WEBSEARCH_FIELDS.has(key)) return 'outbound';
    if (key === 'mode' && !WEBSEARCH_MODES.has(value)) return 'outbound';
  }
  const raw = input.query;
  if (typeof raw !== 'string') return 'outbound';
  if (redact(raw) !== raw) return 'credentials';
  if (raw.length > QUERY_MAX || /\p{C}/u.test(raw)) return 'outbound';
  const q = raw.normalize('NFKC');
  if (q !== raw && redact(q) !== q) return 'credentials';
  if (QUERY_ADDRESS_RE.test(q) || encodedData(q) || bareHost(q)) return 'outbound';
  for (const m of q.matchAll(QUERY_TOKEN_RE)) if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0])) return 'outbound';
  // the domain filters go to the search service too: plain host names only (no address, path or long token-like label)
  let chars = 0;
  for (const key of ['allowed_domains', 'blocked_domains']) {
    const list = input[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > DOMAINS_MAX || !list.every(safeDomain)) return 'outbound';
    for (const d of list) chars += d.length;
  }
  return chars > DOMAIN_CHARS_MAX ? 'outbound' : null;
}
const plainDomain = (d) => typeof d === 'string' && d.length <= 100 && /^(?:\*\.)?[a-z0-9-]{1,24}(?:\.[a-z0-9-]{1,24}){1,4}$/i.test(d) && !/[a-z][A-Z]/.test(d);
// a plain host name whose labels carry no data (not a hex/base32 run, not many digits with letters).
const safeDomain = (d) => plainDomain(d) && !String(d).split('.').some(dataLabel);

const VOWEL_RE = /[aeiouAEIOU]/g;
/** words that together look like encoded data (see above). `q` is NFKC-folded. */
function encodedData(q) {
  // a long run of only digits, or of letters of one case (a CamelCase name such as a registry value is ordinary)
  if (/\p{N}{30,}|\p{Ll}{32,}|\p{Lu}{32,}|\p{Lo}{32,}/u.test(q)) return true;
  for (const m of q.matchAll(/[\p{L}\p{N}]{30,}/gu)) if (/\p{N}/u.test(m[0]) && /\p{L}/u.test(m[0]) && !/\p{Lu}\p{Ll}{2,}/u.test(m[0])) return true;
  if ((q.match(/%[0-9A-Fa-f]{2}/g) || []).length >= 3) return true;
  if ((q.match(/\p{Extended_Pictographic}/gu) || []).length >= 4) return true;
  // data split into hex chunks: 3+ space-separated all-hex tokens (6-16 chars), at least one with a letter a-f
  const hexChunks = q.split(/\s+/).map((w) => w.replace(/^[("'`[{<]+|[)"'`\]}>,;:!?]+$/g, '')).filter((w) => /^[0-9a-f]{6,16}$/i.test(w));
  if (hexChunks.length >= 3 && hexChunks.some((w) => /[a-f]/i.test(w) && /\d/.test(w))) return true;
  let long = 0;
  let coded = 0;
  let codedChars = 0;
  for (const w0 of q.split(/\s+/)) {
    const w = w0.replace(/^[("'`[{<]+|[)"'`\]}>,;:!?]+$/g, '');
    // base64 padding ends a token, and the data before it does not read like a word (few vowels, with a digit or
    // mixed case): prose and ini keys (`AntiAliasing=`) never do both
    if (/^[A-Za-z0-9+/]{6,}={1,2}$/.test(w)) {
      const body = w.replace(/=+$/, '');
      const lets = body.replace(/[^A-Za-z]/g, '');
      if ((lets.match(VOWEL_RE) || []).length < lets.length * 0.25 && (/\d/.test(body) || (/[a-z]/.test(body) && /[A-Z]/.test(body)))) return true;
    }
    const letters = w.replace(/[^A-Za-z]/g, '');
    const fewVowels = (letters.match(VOWEL_RE) || []).length < letters.length * 0.2;
    // a name with a number in it (FrameCapType=9, Medium802_3) has words with vowels and few letter/digit changes
    if (w.length >= 12 && /^[A-Za-z0-9+/=_-]+$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w)
      && (fewVowels || (w.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length >= 4)) long += 1;
    const hexish = /^(?:0x)?[0-9a-f]{6,}$/i.test(w) && /\d/.test(w) && /[a-f]/i.test(w);
    const b64ish = w.length >= 6 && /^[A-Za-z0-9+/]+={0,2}$/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w) && fewVowels;
    // a lone high-entropy token is data on its own: 16+ hex digits with a letter; or a 16+ base64 token carrying a `+`
    // between two base64 characters (prose has `C++`, `a+b`, never a long mixed-case base64 run with a `+` inside it;
    // `/` is left out because namespace and log-channel paths such as `root/Microsoft/Windows` read the same way)
    if (hexish && w.length >= 16) return true;
    if (w.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w) && /[A-Za-z0-9]\+[A-Za-z0-9]/.test(w)) return true;
    if (hexish || b64ish) { coded += 1; codedChars += w.length; }
  }
  return long >= 2 || coded >= 3 || (coded >= 2 && codedChars >= 24);
}

/** a query with an IPv6 address, a whole-query host whose label can carry data, or a
 *  host-like WORD inside a longer query whose dot labels carry data (a hidden-subdomain leak such as
 *  `4f6e65.4f7468.6572.example.com resolve`). */
function bareHost(q) {
  for (const w0 of q.split(/\s+/)) {
    const w = w0.replace(/^[("'`[{<]+|[)"'`\]}>,;!?]+$/g, '');
    if (/^[0-9a-f:]+$/i.test(w) && (w.includes('::') || (w.match(/:/g) || []).length >= 3) && /[0-9a-f]/i.test(w)) return true; // IPv6
    // run the data-label test per dot label of every host-like word, not only on a whole-query host
    if (w.includes('.') && /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(w) && w.split('.').some(dataLabel)) return true;
  }
  const t = q.trim().replace(/\.$/, '');
  if (!/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(t)) return false;
  const labels = t.split('.');
  return labels.length >= 4 || labels.some((l) => l.length >= 10 || (l.length >= 5 && /\d/.test(l) && /\p{L}/u.test(l)));
}

/** a single dot label that carries data — a hex run that has a digit, or a long label packed with
 *  digits mixed into letters (`ab12cd34ef56gh78`). Deliberately narrow: measured on 3336 real WebSearch queries it adds
 *  no false positive, so it leaves ordinary host, file, product and version labels routine — a voltage (`1.435V` ->
 *  `435v`), a DLL (`vcruntime140`), a brush key (`highlightbrushkey`), `office365`, `support-leagueoflegends`,
 *  `package-lock`, `docker-compose`. A lone symbol-free base32/base64 token stays a documented, unseparable gap.
 *  `l` is already NFKC-folded by the caller. */
function dataLabel(l0) {
  const l = String(l0).toLowerCase();
  if (/^[0-9a-f]+$/.test(l) && l.length >= 5 && /\d/.test(l) && /[a-f]/.test(l)) return true; // a hex run with a digit
  const digits = (l.match(/\d/g) || []).length;
  return l.length >= 12 && digits >= 3 && digits >= l.length * 0.35 && /[a-z]/.test(l); // a long, digit-packed run
}

const str = (v) => (typeof v === 'string' ? v : '');
const isUnc = (s) => /^[\\/]{2}/.test(s);
/** A host on this computer. The ONE rule, shared with hard-gate.mjs (WebFetch, curl, inline code). */
export const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i.test(h);
const optValue = (v) => { const m = /^-{1,2}[A-Za-z][\w-]*[=:](.*)$/.exec(v); return m ? m[1] : ''; };
const WILD_RE = /[*?[\]]/; // a wildcard for PowerShell, cmd, git pathspecs and the tools; bash: the unquoted ones (word.g)
const SHORT_NAME_RE = /~\d/; // a Windows 8.3 short name (CLAUDE~1.JSO) names another file than it shows

/** F1: `v` has a part that looks like a short name. The project and temp folders as Forge was given
 *  them are not counted (a temp folder is often C:\Users\LONGNA~1\...): they are those folders. */
function shortNamed(v, base, h) {
  if (!SHORT_NAME_RE.test(v)) return false;
  const abs = WILD_RE.test(v) ? null : h.locate(v, base);
  if (!abs) return true;
  for (const known of [h.root, h.tmp]) {
    if (!known) continue;
    const rel = path.relative(known, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return SHORT_NAME_RE.test(rel);
  }
  return true;
}
const DOTDOT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const GLOB_MAX = 1500; // paths one wildcard may expand to here; more is not proven

/** Records why a read was refused (the owner sees it on the card) and refuses. */
function refuse(h, code) {
  if (h && typeof h.note === 'function') h.note(code);
  return false;
}

/** A read target judged by hard-gate.mjs at its real location; without that helper nothing is proven. */
function targetOk(abs, kind, h, tail = '') {
  const code = !abs || typeof h.readProblem !== 'function' ? 'not_allowlisted' : h.readProblem(abs, kind, tail);
  return code ? refuse(h, code) : true;
}

/** F1: a path with a part that looks like an 8.3 short name is never approved. The card still names what
 *  the real file is (a credentials file, a place outside the project) when that can be found out. */
function shortName(targets, h) {
  for (const abs of targets) {
    const code = abs && typeof h.readProblem === 'function' ? h.readProblem(abs, 'list', '') : null;
    if (code) return refuse(h, code);
  }
  return refuse(h, 'not_allowlisted');
}

/** The literal end every match of a glob must have (`**` + `/*.mjs` gives `.mjs`): a superset test of what it can reach. */
function globTail(g) {
  if (g.startsWith('!')) return ''; // a negated glob does not narrow what is read
  return g.slice(Math.max(...[...'*?[]{},!'].map((c) => g.lastIndexOf(c))) + 1).replace(/\\/g, '/').toLowerCase();
}

function readToolAllowed(name, input, h) {
  const spots = [str(input.file_path), str(input.path), str(input.notebook_path)].filter(Boolean);
  const glob = name === 'Glob' ? str(input.pattern) : name === 'Grep' ? str(input.glob) : '';
  if ([...spots, glob].filter(Boolean).some((s) => isUnc(s) || credential(s, h) || winAlias(s))) return false;
  if ([...spots, glob].some((s) => shortNamed(s, h.root, h))) return shortName(spots.map((s) => h.locate(s, h.root)), h); // F1
  if (glob && (CRED_GLOB_RE.test(glob) || DOTDOT_RE.test(glob))) return false;
  if (spots.some((s) => WILD_RE.test(s))) return false; // F2: a path input is literal; a wildcard in it is never proven
  let targets = spots.map((s) => h.locate(s, h.root));
  const search = name === 'Grep' || name === 'Glob';
  if (targets.length === 0) { if (!search && name !== 'LS') return false; targets = [h.root]; }
  let tail = '';
  if (glob) {
    tail = globTail(glob);
    if (name === 'Glob') { // the literal start of the pattern is part of where it looks (`src/**`, `C:/x/**`)
      const cut = glob.search(/[*?[\]{]/);
      const lead = (cut < 0 ? glob : glob.slice(0, cut)).replace(/[^\\/]*$/, '');
      if (lead) targets = targets.map((t) => (t ? h.locate(lead, t) : t));
    }
  }
  // F3: where it really lands. Read: the file. LS: names. Grep reads, and Glob lists, every file below
  // its folder that the glob can match: asked when a sensitive file is among them.
  return targets.every((t) => targetOk(t, name === 'LS' ? 'list' : 'content', h, tail));
}

// Windows opens `name::$DATA`, `name:stream`, `name.` and `name ` as (a stream of) `name` itself, so a
// name check would miss `.claude/settings.json::$DATA` or `.git./config`. Such paths are never allowed.
function winAlias(p) {
  if (!WIN) return false;
  const rest = p.replace(/^[A-Za-z]:/, '');
  return rest.includes(':') || rest.split(/[\\/]/).some((c) => c !== '.' && c !== '..' && /[. ]$/.test(c));
}

/** The name Windows really opens: no stream suffix, no trailing dots or spaces on a part. */
function winName(p) {
  const m = /^([A-Za-z]:)?([\s\S]*)$/.exec(p);
  return (m[1] || '') + m[2].split(/([\\/])/).map((c) => (c === '.' || c === '..' ? c : c.replace(/:.*$/, '').replace(/[. ]+$/, ''))).join('');
}

const credential = (s, h) => h.credential(s) || (WIN && h.credential(winName(s)));

/** A write lands inside the project (real location), outside .git and node_modules, on no protected file. */
function writeOk(abs, h) {
  if (!abs || winAlias(abs)) return false;
  const rel = h.projectRel(abs);
  if (rel === null || h.protectedPath(abs)) return false;
  return !rel.split(/[\\/]/).some((part) => /^(?:node_modules|\.git)$/i.test(part));
}

// ------------------------------------------------------------------ the strict reader

/**
 * Reads one command line the way bash (`sh`) or PowerShell (`ps`) would, but only the plain subset:
 * words, single and double quotes without expansion, `&&` `||` `;` `|` and newlines between commands,
 * `>` `>>` `N>` `N>&M` redirects, and (sh) a heredoc. Returns `{ commands }` or null for anything else.
 * A command is `{ words: [{ v, q, g }], redirects: [{ t } | { dup } | { nul }], heredoc }`: `v` the value,
 * `q` some part was quoted, `g` an unquoted `*` or `?` (a glob).
 * Round 6: PowerShell ends an argument that STARTS with a quote at its closing quote (`".e"+"nv"` is `.e` and
 * `+nv`, `'.e'nv` is `.e` and `nv`), and `''` inside single quotes is a quote in the name. This reader would
 * glue them into one word, so it refuses both; `onRefuse('unjudgeable')` says why.
 */
export function readStrict(text, shell, onRefuse = null) {
  const ps = shell === 'ps';
  const unjudgeable = () => { if (typeof onRefuse === 'function') onRefuse('unjudgeable'); return null; };
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CHARS) return null;
  const s = text.replace(/\r\n/g, '\n');
  if (/[\0-\x08\x0b-\x1f\x7f]/.test(s)) return null; // control characters (also a lone CR)
  // PowerShell reads Unicode quotes, dashes and spaces as syntax; this reader does not, so it refuses them
  if (ps && /[^\t\n\x20-\x7e]/.test(s)) return null;
  const commands = [];
  const heredocs = [];
  let cur = { words: [], redirects: [], heredoc: null };
  let word = null;
  let redirect = null;
  let needCmd = false; // after | && ||: a command must follow
  const open = () => { if (word === null) word = { v: '', q: false, g: false }; };
  const endWord = () => {
    if (word === null) return;
    if (redirect) { cur.redirects.push({ t: word, append: redirect.append === true }); redirect = null; } else cur.words.push(word);
    word = null;
  };
  const endCmd = (sep) => { // the separator that ends the command: 'seq' (; or newline) | 'pipe' | 'and' | 'or' | 'end'
    endWord();
    if (redirect) return false;
    const empty = cur.words.length === 0 && cur.redirects.length === 0;
    const joins = sep === 'pipe' || sep === 'and' || sep === 'or';
    if (empty && (needCmd || joins)) return false;
    if (!empty) { cur.sep = sep; commands.push(cur); needCmd = false; }
    if (joins) needCmd = true;
    cur = { words: [], redirects: [], heredoc: null };
    return true;
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue; }
    if (c === '\n') {
      if (!endCmd('seq')) return null;
      i += 1;
      while (heredocs.length) { // the bodies of the heredocs opened on the line that just ended
        const hd = heredocs.shift();
        const lines = s.slice(i).split('\n');
        let used = 0; let found = false; const body = [];
        for (const line of lines) {
          used += line.length + 1;
          if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) { found = true; break; }
          body.push(line);
        }
        if (!found) return null;
        hd.cmd.heredoc = { quoted: hd.quoted, body: body.join('\n') };
        i += used;
      }
      continue;
    }
    if (c === ';') { if (s[i + 1] === ';' || !endCmd('seq')) return null; i += 1; continue; }
    if (c === '|') {
      if (s[i + 1] === '|') { if (!endCmd('or')) return null; i += 2; continue; }
      if (s[i + 1] === '&') return null; // |& pipes stderr too: not needed, refused
      if (!endCmd('pipe')) return null;
      i += 1; continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { if (!endCmd('and')) return null; i += 2; continue; }
      if (!ps && s[i + 1] === '>') { endWord(); i += 1; continue; } // &> and &>>: the `>` below reads it
      return null; // a background job (sh) or the call operator (PowerShell)
    }
    if (c === '>') {
      if (word !== null && !word.q && (ps ? /^[1-6*]$/ : /^[0-9]$/).test(word.v)) word = null; // the stream number
      else endWord();
      if (redirect) return null;
      i += 1;
      const append = s[i] === '>'; // `>>` only adds to the file (round 7: Forge's memory append path)
      if (append) i += 1;
      if (!ps && s[i] === '|') i += 1;
      if (s[i] === '&') { // N>&M: a copy of another stream, no file
        i += 1;
        const m = /^(?:\d+|-)/.exec(s.slice(i));
        if (!m) return null;
        cur.redirects.push({ dup: true });
        i += m[0].length; continue;
      }
      while (s[i] === ' ' || s[i] === '\t') i += 1;
      if (ps && /^\$null(?![\w:.$])/i.test(s.slice(i))) { cur.redirects.push({ nul: true }); i += 5; continue; }
      redirect = { append }; // the next word is its target
      continue;
    }
    if (c === '<') {
      if (ps || s[i + 1] !== '<' || s[i + 2] === '<') return null; // only a sh heredoc
      const m = /^<<(-?)[ \t]*(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/.exec(s.slice(i));
      if (!m || cur.heredoc || heredocs.some((h) => h.cmd === cur)) return null;
      endWord();
      if (redirect) return null;
      const delim = m[2] || m[3] || m[4] || m[5];
      heredocs.push({ delim, strip: m[1] === '-', quoted: !m[5], cmd: cur });
      cur.heredoc = { pending: true };
      i += m[0].length; continue;
    }
    if (c === "'") {
      const starts = word === null;
      open(); word.q = true;
      let j = i + 1;
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) return null;
        word.v += s.slice(j, k);
        if (ps && s[k + 1] === "'") return unjudgeable(); // '' is a quote inside the name in PowerShell
        i = k + 1; break;
      }
      if (ps && starts && i < n && !/[\s;|&>]/.test(s[i])) return unjudgeable();
      continue;
    }
    if (c === '"') {
      const starts = word === null;
      open(); word.q = true;
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        const d = s[j];
        if (d === '"') { if (ps && s[j + 1] === '"') return null; break; }
        if (d === '$' || d === '`') return null; // expansion inside double quotes
        if (!ps && d === '\\') {
          const e = s[j + 1];
          if (e === '"' || e === '\\') { word.v += e; j += 2; continue; }
          if (e === '\n') { j += 2; continue; }
          word.v += d; j += 1; continue;
        }
        word.v += d; j += 1;
      }
      i = j + 1;
      if (ps && starts && i < n && !/[\s;|&>]/.test(s[i])) return unjudgeable();
      continue;
    }
    if (!ps && c === '\\') { if (s[i + 1] !== '\n') return null; i += 2; continue; } // only a line continuation
    if ('$`(){}[]#'.includes(c)) return null;
    if (!ps && c === '!') return null;
    if (ps && '@,!'.includes(c)) return null;
    if (!ps && c === '~' && word === null && !/^~(?:$|[/\s;|&<>])/.test(s.slice(i))) return null; // ~user, ~+
    open();
    if (c === '*' || c === '?') word.g = true;
    word.v += c;
    i += 1;
  }
  if (!endCmd('end') || heredocs.length || needCmd) return null;
  if (commands.some((cmd) => cmd.heredoc && cmd.heredoc.pending)) return null;
  return { commands };
}

// ------------------------------------------------------------------ commands

function shellAllowed(text, isPs, h, depth, bases0) {
  const read = readStrict(text, isPs ? 'ps' : 'sh', (code) => refuse(h, code));
  if (!read) return false;
  let bases = bases0;
  const cmds = read.commands;
  for (let k = 0; k < cmds.length; k++) {
    const cmd = cmds[k];
    if (cmd.words.length === 0) return false; // a bare `> file` empties a file
    if (cmd.heredoc && !cmd.heredoc.quoted) return false; // an unquoted heredoc expands $( ) and `...`
    // afterPipe: this command reads the output of the one before it; toPipe: the next command reads its
    // output. feedsText (PowerShell): a later command of the same pipeline reads the FILES this one lists
    // (Get-ChildItem | Select-String), so its folders are judged as read, not as listed. script: a
    // package script, which cmd.exe may run.
    const env = { h, isPs, bases, depth, script: depth > 0, afterPipe: k > 0 && cmds[k - 1].sep === 'pipe', toPipe: cmd.sep === 'pipe', feedsText: isPs && feedsText(cmds, k) };
    for (const r of cmd.redirects) if (!redirectOk(r, env)) return false;
    const r = judgeCommand(cmd.words, env);
    if (!r) return false;
    if (r.cd) {
      bases = cdOnlyPath(cmds, k) ? r.cd : [...new Set([...bases, ...r.cd])];
      if (bases.length > MAX_BASES) return false;
    }
  }
  return true;
}

const PS_FILE_READERS = new Set(['select-string', 'sls']);

/** PowerShell: a later command in the pipeline of command `k` reads the files it is handed. */
function feedsText(cmds, k) {
  for (let j = k; j < cmds.length - 1 && cmds[j].sep === 'pipe'; j++) {
    const next = cmds[j + 1].words[0];
    if (next && PS_FILE_READERS.has(next.v.toLowerCase())) return true;
  }
  return false;
}

/** True when nothing after the cd at `k` can run unless the cd worked: it is not after `||` or in a pipe,
 *  and only `&&` and `|` follow it (`cd sub && npm test`). Otherwise both folders are judged. */
function cdOnlyPath(cmds, k) {
  if (k > 0 && !['seq', 'and'].includes(cmds[k - 1].sep)) return false;
  if (!['and', 'end'].includes(cmds[k].sep)) return false;
  return cmds.slice(k + 1).every((c) => ['and', 'pipe', 'end'].includes(c.sep));
}

function redirectOk(r, env) {
  if (r.dup || r.nul) return true;
  const t = r.t;
  if (!t) return false;
  if (NULL_TARGETS.has(t.v.toLowerCase())) return true;
  if (t.g) return false;
  return env.bases.every((b) => {
    if (shortNamed(t.v, b, env.h)) return false;
    const abs = pathOf(t.v, b, env);
    // `>>` into one of Forge's end-of-run memory files of this project (hard-gate.mjs MEMORY_LOG_RE) only
    // adds a line; a `>` there, or any other write of Forge's memory stores, is refused by writeOk (protectedPath)
    if (r.append === true && abs && !winAlias(abs) && typeof env.h.memoryLog === 'function' && env.h.memoryLog(abs)) return true;
    return writeOk(abs, env.h);
  });
}

/** The absolute path a literal word names from `base`, or null. PowerShell reads `/x`, `\x` and `~` differently, so they are refused there. */
function pathOf(v, base, env) {
  if (!v || isUnc(v) || /^[A-Za-z]:(?![\\/])/.test(v)) return null; // C:x is relative to drive C's own folder
  if (env.isPs && /^[\\/~]/.test(v)) return null;
  return env.h.locate(v, base);
}

/** Every base sees `v` inside the project (a glob: its literal part, never with a `..` step). */
function inProjectAll(word, env) {
  let v = word.v;
  if (word.g) {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v)) return false;
    v = v.slice(0, v.search(/[*?]/)).replace(/[^\\/]*$/, '') || '.';
  }
  return env.bases.every((b) => { const abs = pathOf(v, b, env); return abs !== null && env.h.projectRel(abs) !== null; });
}

function judgeCommand(words, env) {
  let w = words;
  if (!env.isPs && !w[0].q && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w[0].v)) return false; // VAR=x before a command
  if (!env.isPs && !w[0].q && w[0].v === 'timeout') { // GNU timeout N cmd
    if (!w[1] || w[1].q || !/^\d+(?:\.\d+)?[smhd]?$/.test(w[1].v)) return false;
    w = w.slice(2);
    if (w.length === 0) return false;
  }
  const head = w[0];
  if (head.g) return false;
  let name = head.v;
  if (/[\\/]/.test(name)) { // a program by path: only the node binary itself
    if (!KNOWN_NODE_RE.test(name) && path.resolve(name) !== path.resolve(process.execPath)) return false;
    name = 'node';
  } else if (head.q) return false;
  name = name.toLowerCase().replace(/\.exe$/, '');
  const table = env.isPs ? PS_COMMANDS : SH_COMMANDS;
  if (!Object.hasOwn(table, name)) return false;
  const args = w.slice(1);
  // a search pattern or a sed script is text, not a path: `process.env` or `state.key` in it is no file.
  // It is still checked against the names that are safe to look for in any text.
  const text = patternSlots(name, args, env.isPs);
  for (const [i, a] of args.entries()) {
    const val = optValue(a.v);
    if (isUnc(a.v) || isUnc(val)) return false;
    const secret = text.has(i) ? (s) => secretText(s, env.h) : (s) => credential(s, env.h);
    // a program whose words are paths (cat, Get-Content) names the reason; elsewhere the word may be data
    if (secret(a.v) || (val && secret(val))) return PATH_READERS.has(table[name]) ? refuse(env.h, 'credentials') : false;
    if (env.isPs && (a.v === '--%' || a.v.includes('::'))) return false; // `::` is a provider-qualified path
  }
  return table[name](args, env, name);
}

const secretText = (s, h) => (typeof h.secretText === 'function' ? h.secretText(s) || (WIN && h.secretText(winName(s))) : credential(s, h));

// ---- where a reading program reads

const isOption = (v) => v.startsWith('-') && v.length > 1;

/** The arguments that are a search pattern or a sed script (indexes). Only when that is certain; a
 *  word wrongly left out is merely checked as a path too. */
function patternSlots(name, args, isPs) {
  const out = new Set();
  if (isPs) {
    if (name === 'select-string' || name === 'sls') { const k = slsPattern(args); if (k >= 0) out.add(k); }
    return out;
  }
  if (SEARCHERS.has(name)) { const p = searchParse(name, args); if (p.certain) for (const [k, role] of p.roles) if (role === 'pattern') out.add(k); }
  if (name === 'sed') { const p = sedParse(args); if (p) for (const k of p.scripts) out.add(k); }
  // `find . -not -path './.git/*'` filters names; the pattern opens no file (findCmd lists names only)
  if (name === 'find') for (let k = 0; k + 1 < args.length; k++) if (FIND_NAME_TESTS.test(args[k].v)) out.add(k + 1);
  return out;
}
const FIND_NAME_TESTS = /^-(?:i?name|i?path|i?wholename|i?regex|i?lname)$/;

const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
// grep: short options without a value, short options with one (-e and -f give the pattern), and the
// long options by their full name. An abbreviation or an unknown option makes the reading uncertain.
const GREP_OPTS = Object.freeze({
  flags: /^[abcEFGHhIiLlnoPqRrsTUVvwxyZz]$/, values: 'ABCmdD',
  longFlags: new Set(['recursive', 'dereference-recursive', 'line-number', 'ignore-case', 'no-ignore-case', 'files-with-matches', 'files-without-match',
    'count', 'invert-match', 'word-regexp', 'line-regexp', 'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'no-filename',
    'with-filename', 'only-matching', 'quiet', 'silent', 'no-messages', 'text', 'binary', 'null', 'null-data', 'line-buffered', 'initial-tab',
    'byte-offset', 'color', 'colour']),
  longValues: new Set(['after-context', 'before-context', 'context', 'max-count', 'directories', 'devices', 'include', 'exclude', 'exclude-dir',
    'exclude-from', 'label', 'binary-files']),
});
const RG_OPTS = Object.freeze({
  flags: /^[abcFHhIiLlNnoPpqSsUuVvwxz0.]$/, values: 'ABCdEgjMmrTt',
  longFlags: new Set(['files', 'hidden', 'no-hidden', 'no-ignore', 'no-ignore-vcs', 'no-ignore-parent', 'no-ignore-global', 'no-ignore-dot', 'no-ignore-exclude',
    'no-ignore-files', 'ignore-case', 'smart-case', 'case-sensitive', 'line-number', 'no-line-number', 'column', 'no-column', 'count', 'count-matches',
    'files-with-matches', 'files-without-match', 'fixed-strings', 'word-regexp', 'line-regexp', 'invert-match', 'only-matching', 'multiline',
    'multiline-dotall', 'pcre2', 'text', 'binary', 'follow', 'no-follow', 'heading', 'no-heading', 'with-filename', 'no-filename', 'null', 'null-data',
    'json', 'pretty', 'quiet', 'trim', 'vimgrep', 'stats', 'no-messages', 'unrestricted', 'no-unicode', 'crlf', 'one-file-system', 'no-config',
    'passthru', 'sort-files', 'no-mmap', 'mmap', 'glob-case-insensitive', 'no-require-git', 'include-zero', 'byte-offset']),
  longValues: new Set(['after-context', 'before-context', 'context', 'color', 'colors', 'context-separator', 'encoding', 'engine', 'glob', 'iglob',
    'ignore-file', 'max-columns', 'max-count', 'max-depth', 'max-filesize', 'path-separator', 'replace', 'sort', 'sortr', 'threads', 'type',
    'type-add', 'type-clear', 'type-not', 'field-match-separator', 'field-context-separator', 'dfa-size-limit', 'regex-size-limit']),
});

/**
 * grep and rg, read exactly: what each word is. `roles`: index -> 'pattern' (search text), 'value' (a
 * number, a glob, a type), 'file' (a pattern file), 'path' (a file or folder to search). `recursive`:
 * a folder is searched (rg always). `certain` false: an option this reader does not know; the caller
 * then treats every word as a path and assumes the working folder is searched too.
 */
function searchParse(name, args) {
  const rg = name === 'rg';
  const o = rg ? RG_OPTS : GREP_OPTS;
  const roles = new Map();
  const attached = []; // `-fFILE`: a pattern file named inside the option word
  let certain = true;
  let recursive = rg;
  let given = false; // the pattern came with -e/-f/--regexp/--file (or rg --files lists without one)
  const plain = [];
  const next = (i, role) => { if (i + 1 < args.length) roles.set(i + 1, role); return i + 1; };
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '--') { for (let k = i + 1; k < args.length; k++) plain.push(k); break; }
    if (!isOption(v)) { plain.push(i); continue; }
    if (/^-\d+$/.test(v)) { if (rg) certain = false; continue; } // grep -3: lines of context
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const opt = (eq < 0 ? v : v.slice(0, eq)).slice(2);
      if (opt === 'regexp') { given = true; if (eq < 0) i = next(i, 'pattern'); continue; }
      if (opt === 'file') { given = true; if (eq < 0) i = next(i, 'file'); continue; }
      if (rg && opt === 'files') given = true;
      if (!rg && /^(?:recursive|dereference-recursive|directories)$/.test(opt)) recursive = true;
      if (o.longValues.has(opt) && !(eq < 0 && o.longFlags.has(opt))) { if (eq < 0) i = next(i, 'value'); continue; }
      if (o.longFlags.has(opt) && (eq < 0 || /^colou?r$/.test(opt))) continue;
      certain = false;
      continue;
    }
    for (let j = 1; j < v.length; j++) { // a group of short options
      const c = v[j];
      const last = j === v.length - 1;
      if (c === 'e' || c === 'f') {
        given = true;
        if (last) i = next(i, c === 'e' ? 'pattern' : 'file');
        else if (c === 'f') attached.push({ v: v.slice(j + 1), q: true, g: false });
        break;
      }
      if (o.values.includes(c)) {
        if (!rg && c === 'd') recursive = true;
        if (last) i = next(i, 'value');
        break;
      }
      if (!rg && (c === 'r' || c === 'R')) recursive = true;
      if (!o.flags.test(c)) certain = false;
    }
  }
  if (!given && plain.length) roles.set(plain.shift(), 'pattern');
  for (const k of plain) roles.set(k, 'path');
  return { roles, attached, certain, recursive: recursive || !certain, paths: plain.length };
}

/** grep, egrep, fgrep and rg: every file or folder they are given is read; a recursive search with no
 *  folder reads the working folder. When the options are not fully understood, both are assumed. */
function searchCmd({ deny = null } = {}) {
  return (args, env, name) => {
    if (deny && args.some((a) => deny(a.v))) return false;
    const p = searchParse(name, args);
    for (const w of p.attached) if (!readOk(w, 'list', env)) return false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const role = p.roles.get(i);
      if (role === undefined) { if (a.v !== '--' && !optionValueOk(a.v, env)) return false; continue; } // an option word
      if (a.v === '-') continue;
      if (p.certain && (role === 'pattern' || role === 'value')) continue;
      if (!readOk(a, p.certain && role === 'file' ? 'list' : 'content', env)) return false; // a pattern file is read for its patterns only
    }
    const searches = name === 'rg' ? !env.afterPipe : p.recursive; // rg reads a pipe when it is given one
    if (searches && (!p.certain || p.paths === 0)) return env.bases.every((b) => targetOk(b, 'content', env.h));
    return true;
  };
}

const SLS_SWITCHES = ['simplematch', 'casesensitive', 'quiet', 'list', 'noemphasis', 'notmatch', 'allmatches', 'raw'];
const SLS_VALUES = ['pattern', 'path', 'literalpath', 'include', 'exclude', 'encoding', 'context', 'culture', 'inputobject'];

/** Select-String: the value of -Pattern, else the first plain word that is not the value of a parameter. */
function slsPattern(args) {
  const named = args.findIndex((a) => /^-patt/i.test(a.v));
  if (named >= 0) return named + 1 < args.length && !args[named + 1].v.startsWith('-') ? named + 1 : -1;
  for (let i = 0; i < args.length; i++) {
    if (args[i].v.startsWith('-')) continue;
    const prev = i > 0 && args[i - 1].v.startsWith('-') ? args[i - 1].v.slice(1).toLowerCase() : null;
    const isSwitch = prev !== null && prev !== '' && SLS_SWITCHES.some((s) => s.startsWith(prev)) && !SLS_VALUES.some((s) => s.startsWith(prev));
    if (prev === null || isSwitch) return i;
  }
  return -1;
}

/** One path word of a reading program: judged at its real location from every working folder.
 *  kind 'list' shows names only; 'content' prints the file, or reads every file below a folder. */
function readOk(word, kind, env) {
  const v = word.v;
  if (NULL_TARGETS.has(v.toLowerCase())) return true;
  if (env.bases.some((b) => shortNamed(v, b, env.h))) return shortName(WILD_RE.test(v) ? [] : env.bases.map((b) => pathOf(v, b, env)), env.h); // F1
  if (winAlias(v)) return refuse(env.h, 'not_allowlisted'); // a stream or trailing-dot alias is never proven
  const wild = env.isPs || env.script ? WILD_RE.test(v) : word.g; // PowerShell and cmd.exe expand a quoted wildcard too
  if (!wild) return env.bases.every((b) => targetOk(pathOf(v, b, env), kind, env.h));
  const loose = env.isPs || env.script; // PowerShell and cmd.exe expand wildcards their own way
  // a `..` step is read only in the literal start of the word (`../../*.css`), never at or after the wildcard
  const firstWild = v.slice(0, v.search(/[*?[\]]/)).search(/[^\\/]*$/); // where the part with the first wildcard starts
  if (DOTDOT_RE.test(v.slice(firstWild))) return false;
  if (kind !== 'list' && loose) return false; // F2: file text behind an expansion not reproduced here is never proven
  return env.bases.every((b) => {
    const list = expandGlob(v, b, env, loose);
    // a lister shows names: each match must still be inside the project (a link may point out), whatever it is called
    return list !== null && list.every((abs) => targetOk(abs, kind === 'list' ? 'where' : kind, env.h));
  });
}

/** F2: every path a wildcard can expand to from `base`, as a superset (dot files, `.` and `..`, and any
 *  letter case match too), or null when it cannot be listed (`**`, a bracket set, too many). With no
 *  match bash passes the word as written, so that is the one result. `loose`: PowerShell or cmd.exe,
 *  where a backslash separates folders too; only used there for a lister, never for file text. */
function expandGlob(v, base, env, loose = false) {
  if (loose && /[[\]]/.test(v)) return null;
  const parts = loose ? v.split(/[\\/]/) : v.split('/');
  let i = 0;
  while (i < parts.length && !/[*?]/.test(parts[i])) i += 1;
  const head = pathOf(parts.slice(0, i).join('/') || (v.startsWith('/') ? '/' : '.'), base, env);
  if (head === null) return null;
  let found = [head];
  for (; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '') continue;
    if (seg.includes('**')) return null; // recursive when globstar is on
    const next = [];
    if (!/[*?]/.test(seg)) for (const d of found) next.push(path.join(d, seg));
    else {
      const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      for (const d of found) {
        let names;
        try { names = fs.readdirSync(d); } catch { continue; } // not a folder: nothing below it matches
        for (const n of ['.', ...names]) if (re.test(n)) next.push(path.join(d, n));
        // `.*` also matches `..`: the parent of the folder as written, and of where a link in it points
        if (re.test('..')) {
          const real = typeof env.h.realOf === 'function' ? env.h.realOf(d) : null;
          if (!real) return null;
          next.push(path.dirname(d), path.dirname(real));
        }
        if (next.length > GLOB_MAX) return null;
      }
    }
    if (next.length > GLOB_MAX) return null;
    found = next;
  }
  return found.length ? found : [pathOf(v, base, env)];
}

/** The value of `--option=value` may name a file (diff --from-file=x): where it is and what it is called,
 *  never its contents as a folder. A value with a wildcard is a filter (grep --include=*.js). */
function optionValueOk(v, env) {
  const val = optValue(v);
  if (!val || WILD_RE.test(val) || env.isPs) return true;
  if (env.bases.some((b) => shortNamed(val, b, env.h)) || /^[A-Za-z]:(?![\\/])/.test(val)) return refuse(env.h, 'not_allowlisted');
  // a value no path can be made of (`--format=%s%n`) is not a file; one with a folder in it must be judged
  return env.bases.every((b) => { const abs = pathOf(val, b, env); return abs === null ? !/[\\/]|^~/.test(val) : targetOk(abs, 'list', env.h); });
}

// ---- read-only programs

const shortGroup = (v) => (/^-[A-Za-z0-9]+$/.test(v) ? v.slice(1) : '');

/**
 * A read-only program. `kind`: 'data' opens no file (echo, basename); 'list' shows names and sizes
 * (ls, stat); 'content' prints file text (cat, grep): every plain argument is then a path that must be
 * provably fine (readOk), except a sed script. `deny(arg, i, args)` refuses an argument; `maxPos` caps
 * the plain arguments. grep and rg have their own reader (searchCmd).
 */
function reader(kind, { deny = null, maxPos = Infinity } = {}) {
  return (args, env, name) => {
    let pos = 0;
    for (let i = 0; i < args.length; i++) {
      if (deny && deny(args[i].v, i, args)) return false;
      if (!isOption(args[i].v)) pos += 1;
    }
    if (pos > maxPos) return false;
    if (kind === 'data') return true;
    const text = patternSlots(name, args, env.isPs);
    let rest = false; // after `--` every word is plain
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (text.has(i) || a.v === '-') continue;
      if (!rest && !env.isPs && a.v === '--') { rest = true; continue; }
      if (!rest && isOption(a.v)) { if (!optionValueOk(a.v, env)) return false; continue; }
      if (!readOk(a, kind, env)) return false;
    }
    return true;
  };
}

const plain = reader('data');
const lister = reader('list');
const content = reader('content');
const noArgs = reader('data', { maxPos: 0, deny: (v) => v.startsWith('-') });
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from']);
const FIND_FILE_TESTS = /^-(?:newer\w*|anewer|cnewer|samefile)$/;

/** find lists names: its start folders, and the files a test compares with, are judged as listed.
 *  In a package script cmd.exe may run Windows' find.exe, which prints the matching lines of its files. */
function findCmd(args, env) {
  if (args.some((a) => FIND_ACTIONS.has(a.v))) return false;
  let i = 0;
  while (i < args.length && /^-(?:[HLP]|O\d|D)$/.test(args[i].v)) i += args[i].v === '-D' ? 2 : 1;
  let roots = 0;
  for (; i < args.length && !args[i].v.startsWith('-') && !['(', ')', '!', ','].includes(args[i].v); i++) {
    roots += 1;
    if (!readOk(args[i], env.script ? 'content' : 'list', env)) return false;
  }
  for (; i < args.length; i++) {
    if (FIND_FILE_TESTS.test(args[i].v)) { if (!args[i + 1] || !readOk(args[i + 1], 'list', env)) return false; i += 1; }
  }
  return roots > 0 || env.bases.every((b) => targetOk(b, 'list', env.h));
}

/** sed that only prints: its file arguments are read like cat's. */
function sedRead(args, env) {
  const p = sedParse(args);
  return p !== null && p.files.every((a) => a.v === '-' || readOk(a, 'content', env));
}

/** sed that only prints: -n/-E/-r/-s/-u/-z and scripts of addresses with p, P, d, D, =, l, n, N, q, Q.
 *  Returns `{ scripts: [index], files: [word] }`, or null for anything else. */
function sedParse(args) {
  const scripts = [];
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '-e' || v === '--expression') { const sc = args[i + 1]; if (!sc || !sedPrintOnly(sc.v)) return null; scripts.push(i + 1); i += 1; continue; }
    if (v.startsWith('--expression=')) { if (!sedPrintOnly(v.slice(13))) return null; scripts.push(i); continue; }
    if (/^-[nErsuz]+$/.test(v) || /^--(quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug)$/.test(v)) continue;
    if (v.startsWith('-') && v !== '-') return null; // -i, -f, -l, --in-place, --follow-symlinks, ...
    if (!scripts.length) { if (!sedPrintOnly(v)) return null; scripts.push(i); continue; }
    files.push(args[i]);
  }
  return scripts.length ? { scripts, files } : null;
}


const SED_ADDR = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\\n]|\\.)*/[IM]*)`;
const SED_ADDR2 = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/[IM]*|[+~]\d+)`;
const SED_CMD = String.raw`\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR2})?)?\s*!?\s*(?:[pPdDlnN=]|[qQ]\d*)\s*`;
const SED_SCRIPT_RE = new RegExp(String.raw`^${SED_CMD}(?:[;\n]${SED_CMD})*;?\s*$`);
const sedPrintOnly = (sc) => sc.length <= 500 && SED_SCRIPT_RE.test(sc);

function dateRead(args) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (/^(?:\+.*|-u|--utc|--universal|-R|--rfc-email|-I\w*|--iso-8601(?:=\w+)?|--date=.*)$/.test(v)) continue;
    if (v === '-d' || v === '--date') { if (!args[i + 1]) return false; i += 1; continue; }
    return false; // -s / --set changes the clock, -f reads a list
  }
  return true;
}

// ---- the working folder and new folders

function cdCmd(args, env) {
  const rest = env.isPs ? args.filter((a) => !/^-(?:path|literalpath)$/i.test(a.v)) : args;
  if (rest.length !== 1) return false; // `cd` alone goes home
  const a = rest[0];
  if (a.g || a.v.startsWith('-')) return false; // cd -, cd -P
  // bash looks a relative name up in CDPATH (the owner's profile may set it) unless it starts with . or ..
  if (!env.isPs && !/^(?:\/|[A-Za-z]:[\\/]|\.\.?(?:[\\/]|$))/.test(a.v)) return false;
  const out = [];
  for (const b of env.bases) {
    const abs = pathOf(a.v, b, env);
    if (!abs || env.h.projectRel(abs) === null) return false;
    out.push(abs);
  }
  return { cd: out };
}

function mkdirCmd(args, env) {
  let any = false;
  for (const a of args) {
    if (env.isPs ? /^-force$/i.test(a.v) : /^(?:-p|--parents|-v|--verbose|-pv|-vp)$/.test(a.v)) continue;
    if (a.v.startsWith('-') || a.g) return false;
    if (!env.bases.every((b) => !shortNamed(a.v, b, env.h) && writeOk(pathOf(a.v, b, env), env.h))) return false;
    any = true;
  }
  return any;
}

// ---- git: reading sub-commands only, in this project

function gitCmd(args, env) {
  if (args.length === 1 && args[0].v === '--version') return true;
  let i = 0;
  let bases = env.bases;
  while (i < args.length && args[i].v.startsWith('-')) {
    const v = args[i].v;
    if (/^--(?:no-pager|no-optional-locks|literal-pathspecs|no-replace-objects)$/.test(v)) { i += 1; continue; }
    if (v === '-C') { // only into a folder of this project
      const d = args[i + 1];
      if (!d || d.g) return false;
      const next = bases.map((b) => pathOf(d.v, b, env));
      if (next.some((x) => !x || env.h.projectRel(x) === null)) return false;
      bases = next; i += 2; continue;
    }
    return false; // -c, --git-dir, --work-tree, --exec-path, --config-env, -p, --paginate, ...
  }
  const sub = args[i] ? args[i].v : '';
  const rest = args.slice(i + 1).map((a) => a.v);
  const has = (re) => rest.some((v) => re.test(v));
  const only = (re) => rest.every((v) => re.test(v));
  // --no-index and --contents read any file on disk; --output writes one
  if (has(/^--(?:output|no-index|contents)(?:=|$)/)) return false;
  const here = { ...env, bases };
  const dashes = rest.indexOf('--'); // after `--` every word is a path
  const opts = (dashes < 0 ? rest : rest.slice(0, dashes)).filter(isOption);
  const quietOpts = opts.every((v) => GIT_QUIET_OPT.test(v));
  switch (sub) {
    case 'rev-parse': case 'describe': case 'shortlog': case 'rev-list': case 'merge-base': case 'count-objects':
      return true; // names and object ids only
    case 'ls-files': case 'ls-tree': return gitNamesHere(sub, rest, here);
    case 'status': return !has(/^--verbose$/) && !rest.some((v) => shortGroup(v).includes('v')) && gitNamesHere(sub, rest, here); // -v prints the staged patch
    case 'log': return gitBlobsOk(rest, here) && (quietOpts || gitTextOk(sub, rest, here)); // log prints a patch only when an option asks for one
    case 'diff': case 'show': {
      if (!gitBlobsOk(rest, here)) return false; // before the summary options: a blob ignores --stat, -s, --name-only
      const quiet = quietOpts && opts.some((v) => GIT_SUMMARY_OPT.test(v));
      // an object id may be a blob: `git show <id>` prints it, whatever the options say
      if ((sub === 'show' || !quiet) && gitWords(rest).some(gitObjectId)) return false;
      return quiet || gitTextOk(sub, rest, here);
    }
    case 'blame': return gitBlobsOk(rest, here) && gitTextOk(sub, rest, here);
    case 'cat-file': return gitBlobsOk(rest, here) && has(/^-[tse]$/) && rest.every((v) => !isOption(v) || /^(?:-[tse]|--allow-unknown-type)$/.test(v)); // type, size, exists: never the text
    case 'branch': return only(/^(?:--show-current|-a|--all|-r|--remotes|-v|-vv|--verbose|--list|--no-color|--color(?:=\w+)?|--format=.*|--sort=.*)$/);
    case 'tag': return only(/^(?:-l|--list|-n\d*|--sort=.*|--format=.*)$/);
    case 'remote': return rest.length === 0; // names only: -v prints the URLs, which can hold a token
    case 'stash': return rest[0] === 'list' && rest.slice(1).every((v) => GIT_QUIET_OPT.test(v)); // -p prints patches
    default: return false; // add, commit, checkout, fetch, push, config, grep (reads every tracked file), worktree, an alias, ...
  }
}

/**
 * Round 6 (LOW): ls-files, ls-tree and status print names. Names from outside the project are not the
 * project's: a path outside it, a magic pathspec (`:/` is the top of the repository) or ls-tree --full-tree
 * asks. ls-tree's first plain word is the tree (a `REV:path` tree is checked like a blob, gitBlobsOk).
 */
function gitNamesHere(sub, rest, env) {
  if (rest.includes('--full-tree')) return false;
  const dd = rest.indexOf('--');
  let words = rest.filter((v, k) => v !== '--' && (!isOption(v) || (dd >= 0 && k > dd)));
  if (sub === 'ls-tree' && (dd < 0 || rest.indexOf(words[0]) < dd)) {
    if (words.length && !gitBlobsOk([words[0]], env)) return false;
    words = words.slice(1);
  }
  for (const v of words) {
    if (v.startsWith(':')) return false;
    if (!env.bases.every((b) => { const abs = pathOf(v, b, env); return abs !== null && env.h.projectRel(abs) !== null; })) return refuse(env.h, 'outside_folder');
  }
  return true;
}

// git options that never make diff, show or log print file text
const GIT_QUIET_OPT = /^(?:--stat(?:=[\w,.]+)?|--shortstat|--numstat|--name-only|--name-status|--summary|--dirstat(?:=[\w,.]+)?|--raw|-s|--no-patch|--quiet|--oneline|--cached|--staged|--no-color|--color(?:=\w+)?|-\d+|-n\d*|--max-count=\d+|--skip=\d+|--format=.*|--pretty(?:=.*)?|--date=.*|--abbrev-commit|--no-abbrev-commit|--abbrev(?:=\d+)?|--no-merges|--merges|--first-parent|--all|--branches|--tags|--remotes|--graph|--decorate(?:=\w+)?|--no-decorate|--reverse|--follow|--since=.*|--until=.*|--after=.*|--before=.*|--author=.*|--committer=.*|--grep=.*|-i|--regexp-ignore-case|--diff-filter=\w+|-M\d*%?|--find-renames(?:=\d+%?)?|--no-renames|-z|--topo-order|--date-order|--author-date-order|--no-walk|--left-right|--count)$/;
// ... and the ones that replace the patch of diff and show by a summary
const GIT_SUMMARY_OPT = /^(?:--stat(?:=[\w,.]+)?|--shortstat|--numstat|--name-only|--name-status|--summary|--dirstat(?:=[\w,.]+)?|--raw|-s|--no-patch|--quiet)$/;
const GIT_OBJECT_ID = /^[0-9a-f]{4,64}$/i;
/** A bare object id, also as one side of `a..b`: it may name a blob (a file's text), not a commit. */
const gitObjectId = (v) => v.split(/\.{2,3}/).some((p) => GIT_OBJECT_ID.test(p));
const GIT_BLOB_AT = /^[^:]*:(?!\/)./; // `HEAD:path`, `:path`, `:0:path`: one file at a revision (`:/text` finds a commit)

/** The plain words of a git command: revisions and paths. */
const gitWords = (rest) => { const dd = rest.indexOf('--'); return rest.filter((v, k) => v !== '--' && (!isOption(v) || (dd >= 0 && k > dd))); };
const GIT_BLOB_REV = /^(?::\d)?[^:]*:/; // the `REV:`, `:` or `:0:` in front of the path of a blob word

/**
 * Round 5: a `REV:path`, `:path` or `:0:path` word prints one file of the repository. git reads a path
 * that starts with ./ or ../ from the working folder and any other from the top of the repository, which
 * can be above the project (a project inside a bigger repository). Provably inside the project only when
 * the path has no `..` part, is not absolute or on a drive, and the top of the repository is inside the
 * project (gitTop). A Windows drive path (`C:\x`) has the same shape: `git diff C:\a C:\b` outside the
 * working tree is an implied --no-index that prints both files, so it asks too.
 */
function gitBlobsOk(rest, env) {
  const blobs = gitWords(rest).filter((v) => GIT_BLOB_AT.test(v));
  if (blobs.length === 0) return true;
  for (const v of blobs) {
    if (WIN && /^[A-Za-z]:/.test(v)) return false;
    const p = v.replace(GIT_BLOB_REV, '');
    if (DOTDOT_RE.test(p) || /^[\\/]|^[A-Za-z]:/.test(p)) return false;
    // `HEAD:kubeconfig` prints the file at that revision; the name check before saw `HEAD:` glued to it
    if (credential(p, env.h)) return refuse(env.h, 'credentials');
  }
  return env.bases.every((b) => gitTop(b, env.h) !== null);
}

/**
 * A git command that prints file text (a patch, a blame, a file at a revision). Provably fine when:
 * no wildcard or `:(magic)` pathspec; every path it names is an ordinary file, or a folder that reaches
 * no sensitive file; and, when it names no path, the whole repository reaches none. `git show REV:path`
 * prints only that file, whose name the caller checked and whose place gitBlobsOk checked.
 */
function gitTextOk(sub, rest, env) {
  const dd = rest.indexOf('--');
  const before = (dd < 0 ? rest : rest.slice(0, dd)).filter((v) => !isOption(v));
  const after = dd < 0 ? [] : rest.slice(dd + 1);
  if ([...before, ...after].some((v) => WILD_RE.test(v) || v.startsWith(':('))) return false;
  if ((sub === 'show' || sub === 'diff') && before.some(gitObjectId)) return false;
  const blobsOnly = sub === 'show' && before.length > 0 && after.length === 0 && before.every((v) => GIT_BLOB_AT.test(v));
  if (blobsOnly) return true;
  for (const b of env.bases) {
    const one = { ...env, bases: [b] };
    let named = 0;
    // 'repo': the text git prints of a working tree, which is never its own .git folder
    for (const v of after) { named += 1; if (!readOk({ v, q: true, g: false }, 'repo', one)) return false; }
    for (const v of before) {
      // with `--` every word before it is a revision; without it, a word that is on disk is a path
      // (git refuses a word that is both)
      if (dd >= 0 || GIT_BLOB_AT.test(v) || v.startsWith(':')) continue;
      const abs = pathOf(v, b, env);
      if (abs === null || !exists(abs)) continue; // a revision
      named += 1;
      if (!readOk({ v, q: true, g: false }, 'repo', one)) return false;
    }
    if (named > 0) continue;
    const top = gitTop(b, env.h); // no path: every changed file of the repository can be printed
    if (!top || !targetOk(top, 'repo', env.h)) return refuse(env.h, 'not_allowlisted');
  }
  return true;
}

/** The repository `base` is in: the nearest folder with a .git, inside the project; else null. */
function gitTop(base, h) {
  let dir = base;
  for (let k = 0; k < 40 && h.projectRel(dir) !== null; k++) {
    if (exists(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---- node: the test runner, or a Forge tool sub-command that only reads

// Round 7 (H1, M1): node runs ANY file it is given as JavaScript (`node --test notes.txt` runs notes.txt), and a file
// with a document extension does not mark the project as holding new code (hard-gate.mjs INERT_EXT_RE). So a runner
// may be pointed only at a folder or at a TEST file with a JavaScript or TypeScript extension: a *.test.*, *.spec.*,
// test-*, *-test, *_test or test.* name, or a file under a test, tests, __tests__, spec or specs folder; a glob only
// when its own text says both (`src/**/*.test.js`, `test/**/*.mjs`). `node --test scripts/side.js` asks.
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_NAME_RE = /(?:^|[\\/])(?:test|tests|__tests__|spec|specs)[\\/]|(?:^|[\\/])(?:test|spec)(?:[.\-_][^\\/]*)?$|[^\\/][.\-_](?:test|spec)(?:[.\-_][^\\/]*)?$/i;
export const runnableTestName = (v) => CODE_EXT_RE.test(v) && TEST_NAME_RE.test(v);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** A runner's file argument (see above): a folder, or a test file. The name is read INSIDE the project, where the
 *  file really is (a project that sits under a folder named tests is not all tests; a link named x.test.js that
 *  points at scripts/deploy.js is not a test file). A glob is read as written, so it must be relative. */
function testTarget(word, env) {
  const v = word.v;
  if (word.g || WILD_RE.test(v)) return !/^(?:[\\/~]|[A-Za-z]:)/.test(v) && runnableTestName(v);
  return env.bases.every((b) => {
    const abs = pathOf(v, b, env);
    if (!abs) return false;
    if (isDir(abs)) return true; // node only discovers test-named JavaScript and TypeScript files in a folder
    const rel = env.h.projectRel(abs);
    return rel !== null && runnableTestName(rel);
  });
}

const NODE_REPORTERS = /^(?:spec|tap|dot|junit|lcov)$/;
// Forge tools whose sub-command is known to only read (checked against their source):
// forge-runinfo status|runs, forge-scribe list, forge-runcontract plan ("read-only, never logs"), and
// forge-doctor (the self-test behind the repository's `npm test`; without --run or --receipt it writes nothing).
const FORGE_TOOLS = Object.freeze({
  'forge-runinfo.cjs': { subs: ['status', 'runs'], flags: ['--json'], values: [], dirs: [] },
  'forge-scribe.cjs': { subs: ['list'], flags: ['--json'], values: ['--status'], dirs: [] },
  'forge-runcontract.cjs': { subs: ['plan'], flags: ['--json'], values: ['--run', '--domain', '--complexity'], dirs: [] },
  'forge-doctor.cjs': { subs: null, flags: ['--json'], values: [], dirs: ['--root'] },
});
// L1 (round-3): the committed Forge-bin test files (git ls-files .claude/forge-bin). Only
// these auto-run (no arguments). The old rule auto-ran ANY forge-*.test.cjs by name, so an agent could
// write and run forge-evil.test.cjs; it now asks. An explicit committed list is used instead of a
// git-HEAD-unchanged probe on purpose: the allow-list must stay a pure, synchronous, side-effect-free
// reader (no spawning git in the permission hot path; git status is cwd/lock-sensitive and an attacker
// could stage or commit to pass it). A new or renamed test file is added here before it auto-runs.
const FORGE_TEST_FILES = new Set(['forge-doctor.test.cjs', 'forge-runcontract.test.cjs', 'forge-runinfo.test.cjs', 'forge-scribe.test.cjs']);
// Forge's own end-of-run memory update (/forge step 12) goes through forge-run-file.cjs append, which only
// ADDS a draft to one of these files (checked against its source). A Write, Edit or redirect into them
// asks (hard-gate.mjs AUTO_RUN_RE), so this one append-only path is what stays routine. FORGE_SKILL_REGISTRY.md, which
// the tool also accepts, is the router's list of skills: it asks.
const RUN_FILE_MEMORY = new Set(['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_DECISIONS.md']);
const RUN_FILE_LESSON_RE = /^agent-memory\/[a-z0-9-]+\/MEMORY\.md$/;

/** `forge-run-file.cjs append --file <memory file> --from <draft>`: exactly these two options, a listed memory file,
 *  and a draft that is a plain file inside the project or the temp folder that is not sensitive (it is copied into a
 *  file every later session reads). Stdin (`--from -`) is not proven. */
function runFileAppend(rest, env) {
  if (!rest[0] || rest[0].v !== 'append') return false;
  let file = null; let from = null;
  for (let k = 1; k < rest.length; k++) {
    const v = rest[k].v;
    const eq = v.indexOf('=');
    const opt = eq > 0 ? v.slice(0, eq) : v;
    const val = eq > 0 ? { v: v.slice(eq + 1), q: rest[k].q, g: false } : rest[k + 1];
    if (eq < 0) k += 1;
    if (!val) return false;
    if (opt === '--file' && file === null) file = val.v;
    else if (opt === '--from' && from === null) from = val;
    else return false;
  }
  if (file === null || from === null || !(RUN_FILE_MEMORY.has(file) || RUN_FILE_LESSON_RE.test(file))) return false;
  if (from.v === '-' || from.g || WILD_RE.test(from.v)) return false;
  return readOk(from, 'content', env);
}

/**
 * Round 6 (HIGH-2): a runner (test, build, lint, typecheck) executes the project's code and config. While the
 * project holds code a routine step wrote that no owner-approved run has covered (h.codeWritten, kept per
 * project folder by permissions/store.mjs), a runner the allow-list would pass asks: code 'wrote_code'. Only
 * `--version` stays. What the runner refused for another reason keeps that reason.
 */
const runner = (fn) => (args, env, name) => {
  if (!fn(args, env, name)) return false;
  if (args.length === 1 && /^(?:--version|-v)$/.test(args[0].v)) return true;
  // the runner names its family; codeWritten is true, false, or a function of the family
  const family = runnerFamily(name, args);
  if (typeof env.h.runnerSeen === 'function') env.h.runnerSeen(family);
  const cw = env.h.codeWritten;
  // round 11 (L1): the store answers 'first_runner' for a family not yet approved in this folder since the start
  const dirty = typeof cw === 'function' ? cw(family) : cw;
  return dirty === true ? refuse(env.h, 'wrote_code') : dirty === 'first_runner' ? refuse(env.h, 'first_runner') : true;
};

// runner families. Approving a 'wrote_code' card clears the mark only for the families that card ran
// (permissions/store.mjs): a lint or typecheck the owner saw does not cover the tests, the tests do not cover the
// build. A package script is its own family per script name (`npm test` is 'npm:test', `npm run build` 'npm:build');
// a runner inside it names its own family too. Every runner without a family of its own shares the default one.
export const RUNNER_FAMILY_DEFAULT = 'other';
const RUNNER_FAMILIES = Object.freeze({
  node: 'node-test', vitest: 'js-test', jest: 'js-test', mocha: 'js-test', tsc: 'tsc', eslint: 'lint', prettier: 'lint',
  make: 'make', gmake: 'make', nmake: 'make', cmake: 'make', pytest: 'python', python: 'python', python3: 'python', py: 'python',
  cargo: 'cargo', go: 'go', dotnet: 'dotnet', gradle: 'gradle', gradlew: 'gradle', mvn: 'gradle', mvnw: 'gradle',
  'forge-bin': 'forge', // round 11b (N2): a Forge tool (forge-doctor, a forge-bin test file) loads and runs project code
});

/** The family of runner `name` with argument words `args` ({ v } objects or strings). */
export function runnerFamily(name, args = []) {
  const words = args.map((a) => (typeof a === 'string' ? a : a && typeof a.v === 'string' ? a.v : ''));
  const n = String(name || '').toLowerCase();
  if (n === 'npm' || n === 'pnpm' || n === 'yarn' || n === 'bun') {
    const w = words.filter((v) => !/^(?:-s|--silent|--if-present)$/.test(v));
    if (w.length && /^(?:test|t|tst)$/.test(w[0])) return 'npm:test';
    if (w.length >= 2 && /^(?:run|run-script)$/.test(w[0])) return 'npm:' + w[1];
    return RUNNER_FAMILY_DEFAULT;
  }
  if (n === 'npx') {
    const k = words.findIndex((v) => !/^(?:--no-install|--no)$/.test(v));
    return k < 0 ? RUNNER_FAMILY_DEFAULT : runnerFamily(words[k], words.slice(k + 1));
  }
  return Object.hasOwn(RUNNER_FAMILIES, n) ? RUNNER_FAMILIES[n] : RUNNER_FAMILY_DEFAULT;
}

function nodeCmd(args, env) {
  if (args.length === 1 && /^(?:--version|-v)$/.test(args[0].v)) return true;
  if (args.some((a) => a.v === '--test')) return nodeTestRun(args, env, 'node');
  const first = args[0];
  if (!first || first.v.startsWith('-') || first.g) return false; // -e, --eval, -p, -r, a program from stdin, ...
  // round 11b (N2): forge-doctor and the forge-bin test files run project checks, so they are runners; the read-only
  // tools (runinfo, scribe, runcontract plan) and the forge-run-file append stay plain (HIGH-2)
  return /(?:^|[\\/])forge-(?:doctor\.cjs|[\w-]+\.test\.cjs)[\\/]*$/i.test(first.v) ? forgeRun(args, env, 'forge-bin') : forgeTool(first, args.slice(1), env);
}

function nodeTest(args, env) {
  let sawTest = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '--test') { sawTest = true; continue; }
    if (/^--(?:test-only|test-force-exit|experimental-test-coverage|no-warnings|trace-warnings)$/.test(v)) continue;
    if (/^--test-(?:concurrency|timeout)=\d+$/.test(v) || /^--test-shard=\d+\/\d+$/.test(v)) continue;
    if (/^--test-reporter=/.test(v)) { if (!NODE_REPORTERS.test(v.slice(16))) return false; continue; }
    if (/^--test-(?:name|skip)-pattern=./.test(v)) continue;
    if (v === '--test-name-pattern' || v === '--test-skip-pattern') { if (!args[i + 1]) return false; i += 1; continue; }
    if (v === '--test-reporter') { if (!args[i + 1] || !NODE_REPORTERS.test(args[i + 1].v)) return false; i += 1; continue; }
    if (v === '--test-concurrency' || v === '--test-timeout') { if (!args[i + 1] || !/^\d+$/.test(args[i + 1].v)) return false; i += 1; continue; }
    if (v.startsWith('-')) return false; // --import, --require, --loader, --env-file, --inspect, -e, ...
    // node reads options only before the first file: `node evil.js --test` runs evil.js
    if (!sawTest || !inProjectAll(args[i], env)) return false; // a test file or glob of this project
    if (!testTarget(args[i], env)) return false; // a test file by name, never notes.txt or scripts/side.js
  }
  return true;
}

function forgeTool(first, rest, env) {
  for (const b of env.bases) {
    const abs = pathOf(first.v, b, env);
    const rel = abs ? env.h.projectRel(abs) : null;
    const parts = rel === null ? [] : rel.split(/[\\/]/);
    if (parts.length !== 3 || !sameName(parts[0], '.claude') || !sameName(parts[1], 'forge-bin')) return false;
    const file = WIN ? parts[2].toLowerCase() : parts[2];
    if (FORGE_TEST_FILES.has(file)) { if (rest.length) return false; continue; } // a committed Forge test file
    if (file === 'forge-run-file.cjs') { if (!runFileAppend(rest, { ...env, bases: [b] })) return false; continue; }
    const spec = Object.hasOwn(FORGE_TOOLS, file) ? FORGE_TOOLS[file] : null;
    if (!spec) return false;
    let k = 0;
    if (spec.subs) { if (!rest[0] || !spec.subs.includes(rest[0].v)) return false; k = 1; }
    for (; k < rest.length; k++) {
      const v = rest[k].v;
      if (spec.flags.includes(v)) continue;
      const eq = v.indexOf('=');
      const opt = eq > 0 ? v.slice(0, eq) : v;
      const val = eq > 0 ? v.slice(eq + 1) : rest[k + 1] && rest[k + 1].v;
      if (eq < 0) k += 1;
      if (spec.values.includes(opt) && typeof val === 'string' && SIMPLE_VALUE_RE.test(val)) continue;
      if (spec.dirs.includes(opt) && typeof val === 'string') {
        const d = pathOf(val, b, env);
        if (d && env.h.projectRel(d) !== null) continue;
      }
      return false;
    }
  }
  return true;
}

const sameName = (a, b) => (WIN ? a.toLowerCase() === b : a === b);

// ---- npm and npx: the package scripts are read and judged, not trusted by name

const NPM_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck']);

function npmCmd(args, env) {
  if (args.length === 1 && /^(?:--version|-v)$/.test(args[0].v)) return true;
  const dash = args.findIndex((a) => a.v === '--');
  const before = dash < 0 ? args : args.slice(0, dash);
  const extra = dash < 0 ? [] : args.slice(dash + 1);
  const words = before.filter((a) => !/^(?:-s|--silent|--if-present)$/.test(a.v));
  if (words.some((a) => a.q || a.g || !SIMPLE_ARG_RE.test(a.v))) return false;
  let name = null;
  if (words.length === 1 && /^(?:test|t|tst)$/.test(words[0].v)) name = 'test';
  else if (words.length === 2 && /^(?:run|run-script)$/.test(words[0].v)) name = words[1].v;
  if (!name) return false; // install, exec, publish, a config flag (--script-shell=...), ...
  // PowerShell 5.1 drops `--` on the way to npm.cmd, which would turn the extra words into npm config flags
  if (extra.length && (env.isPs || !extra.every((a) => SIMPLE_ARG_RE.test(a.v)))) return false;
  if (env.depth >= MAX_DEPTH) return false;
  const safeName = NPM_SCRIPTS.has(name);
  const refuse = (line, base) => { // hard-gate.mjs judges the refused script to name its reason (M7)
    if (typeof env.h.refusedScript === 'function') env.h.refusedScript(line, base);
    return false;
  };
  for (const base of env.bases) {
    const scripts = packageScripts(base, env.h);
    if (!scripts) return false;
    for (const s of ['pre' + name, name, 'post' + name]) {
      if (!Object.hasOwn(scripts, s)) continue;
      if (typeof scripts[s] !== 'string') return false;
      const line = s === name && extra.length ? scripts[s] + ' ' + extra.map((a) => a.v).join(' ') : scripts[s];
      if (!safeName || !scriptAllowed(line, base, env)) return refuse(line, base); // a name outside test/build/lint/typecheck never passes
    }
  }
  return safeName;
}

/** The scripts of the package.json in `base` itself (npm walks up from a folder without one: refused). */
function packageScripts(base, h) {
  const file = path.join(base, 'package.json');
  if (h.projectRel(file) === null) return null;
  try {
    if (fs.statSync(file).size > 1_000_000) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pkg || typeof pkg !== 'object') return null;
    const scripts = pkg.scripts === undefined ? {} : pkg.scripts;
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : null;
  } catch {
    return null;
  }
}

/** A package script runs in cmd.exe on Windows and sh elsewhere: only what both read the same way. */
function scriptAllowed(line, base, env) {
  if (/['%^!`$\r\n]/.test(line)) return false; // cmd variables and escapes; single quotes are not quotes in cmd
  for (const m of line.matchAll(/"([^"]*)"/g)) if (/[&|<>()]/.test(m[1])) return false; // cmd would still see these
  return shellAllowed(line, false, env.h, env.depth + 1, [base]);
}

const NPX_BINS = Object.freeze({ vitest: vitestCmd, tsc: tscCmd, eslint: eslintCmd, vite: viteCmd });

function npxCmd(args, env) {
  let i = 0;
  while (i < args.length && /^(?:--no-install|--no)$/.test(args[i].v)) i += 1;
  const bin = args[i];
  if (!bin || bin.q || bin.g || !Object.hasOwn(NPX_BINS, bin.v)) return false;
  // without the program in this project's node_modules/.bin, npx downloads and runs a package
  if (!env.bases.every((b) => localBin(b, bin.v, env.h))) return false;
  return NPX_BINS[bin.v](args.slice(i + 1), env);
}

/** The folder npm treats as the package (nearest with package.json or node_modules, inside the project) has the program. */
function localBin(base, name, h) {
  let dir = base;
  for (let k = 0; k < 40; k++) {
    if (h.projectRel(dir) === null) return false;
    if (exists(path.join(dir, 'package.json')) || exists(path.join(dir, 'node_modules'))) {
      const bin = path.join(dir, 'node_modules', '.bin', name);
      return exists(bin) || exists(bin + '.cmd');
    }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

const VITEST_REPORTERS = /^(?:default|basic|verbose|dot|json|tap|tap-flat|junit|hanging-process|github-actions)$/;

// Round 7 (LOW): `vitest init` writes files and installs packages; `vitest watch` and `vitest dev` never end.
const VITEST_REFUSED_SUBS = new Set(['init', 'watch', 'dev']);
// Round 7 (H1): the config vitest loads is code; only a vitest or vite config file, which always asks on write
// (hard-gate.mjs AUTO_RUN_RE), is proven. `-c cfg.log` would load a file no write marked.
const VITEST_CONFIG_RE = /(?:^|[\\/])(?:vitest|vite)\.(?:config|workspace)\.(?:[cm]?[jt]s|json)$/i;

function vitestCmd(args, env) {
  if (args[0] && VITEST_REFUSED_SUBS.has(args[0].v)) return false;
  for (let i = args[0] && args[0].v === 'run' ? 1 : 0; i < args.length; i++) {
    const v = args[i].v;
    if (!SIMPLE_ARG_RE.test(v)) return false;
    if (/^--(?:run|silent|passWithNoTests|no-color|no-file-parallelism)$/.test(v) || /^--(?:bail|maxWorkers)=\d+$/.test(v)) continue;
    if (/^--reporter=/.test(v)) { if (!VITEST_REPORTERS.test(v.slice(11))) return false; continue; }
    if (/^--(?:testNamePattern|project)=[A-Za-z0-9_.:@+-]+$/.test(v)) continue;
    if (v === '-t' || v === '--testNamePattern' || v === '--project') { if (!args[i + 1] || !SIMPLE_VALUE_RE.test(args[i + 1].v)) return false; i += 1; continue; }
    if (v === '-c' || v === '--config' || v.startsWith('--config=')) {
      const p = v.startsWith('--config=') ? { v: v.slice(9), g: false } : args[++i];
      if (!p || !SIMPLE_ARG_RE.test(p.v) || !VITEST_CONFIG_RE.test(p.v) || !inProjectAll(p, env)) return false;
      continue;
    }
    if (v.startsWith('-')) return false; // --outputFile, --coverage, --ui, --api, --root, --inspect, ...
  }
  return true; // the other words are file-name filters
}

function tscCmd(args, env) {
  if (args.length === 1 && /^(?:--version|-v)$/.test(args[0].v)) return true;
  let noEmit = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (!SIMPLE_ARG_RE.test(v)) return false;
    if (v === '--noEmit') { noEmit = true; continue; }
    if (/^--(?:pretty|skipLibCheck)$/.test(v)) continue;
    if (v === '-p' || v === '--project') { const p = args[i + 1]; if (!p || !SIMPLE_ARG_RE.test(p.v) || !inProjectAll(p, env)) return false; i += 1; continue; }
    return false; // -b, --outDir, --declaration, a file list, ...
  }
  return noEmit;
}

function eslintCmd(args, env) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (!SIMPLE_ARG_RE.test(v)) return false;
    if (/^--(?:quiet|no-warn-ignored)$/.test(v) || /^--max-warnings=\d+$/.test(v) || /^--format=(?:stylish|json)$/.test(v)) continue;
    if (v === '--max-warnings') { if (!args[i + 1] || !/^\d+$/.test(args[i + 1].v)) return false; i += 1; continue; }
    if (v === '-f' || v === '--format') { if (!args[i + 1] || !/^(?:stylish|json)$/.test(args[i + 1].v)) return false; i += 1; continue; }
    if (v.startsWith('-')) return false; // --fix, -o, -c, --rulesdir, --plugin, ...
    if (!inProjectAll(args[i], env)) return false;
  }
  return true;
}

function viteCmd(args) {
  if (!args[0] || args[0].v !== 'build') return false;
  const rest = args.slice(1).map((a) => a.v);
  if (rest.length === 0) return true;
  if (rest.length === 1) return /^--mode=[A-Za-z0-9_-]+$/.test(rest[0]);
  return rest.length === 2 && rest[0] === '--mode' && /^[A-Za-z0-9_-]+$/.test(rest[1]);
}

// ---- PowerShell cmdlets that only read

/** A reading cmdlet: no provider paths (env:, HKLM:, cert:), no -Param:value form, no -Credential. */
const psRead = (args) => args.every((a) => {
  if (a.v.startsWith('-')) return !a.v.includes(':') && !/^-cred/i.test(a.v);
  return !/^[A-Za-z][\w-]+:/.test(a.v);
});

/** True when `v` is PowerShell's short form of parameter `-full` (at least `min` letters of it). */
const psParam = (v, full, min) => v.length > min && ('-' + full).startsWith(v.toLowerCase());

/**
 * A reading cmdlet whose plain words are paths. 'list' (Get-ChildItem, Get-Item, Test-Path): names only,
 * unless a later Select-String in the pipeline reads the files it lists (env.feedsText): then its
 * folders are judged as read. 'content' (Get-Content, Select-String, Get-FileHash) prints file text.
 * The value of -Filter/-Include/-Exclude is a name filter, not a path.
 */
function psReader(kind) {
  return (args, env, name) => {
    if (!psRead(args)) return false;
    if (args.some((a) => a.v.startsWith('-') && psParam(a.v, 'wait', 1))) return false; // Get-Content -Wait never ends
    // these cmdlets take the path itself from the pipeline (`'C:\x' | Get-ChildItem`, `... | Get-Content`):
    // only as the first command. Select-String reads piped text, or the files a lister before it names.
    if (env.afterPipe && !PS_FILE_READERS.has(name)) return false;
    const as = kind === 'list' && env.feedsText ? 'content' : kind;
    const text = patternSlots(name, args, true);
    let paths = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.v.startsWith('-') || text.has(i)) continue;
      const prev = i > 0 ? args[i - 1].v : '';
      if (psParam(prev, 'filter', 3) || psParam(prev, 'include', 3) || psParam(prev, 'exclude', 2)) continue;
      paths += 1;
      if (!readOk(a, as, env)) return false;
    }
    if (paths === 0 && kind === 'list') return env.bases.every((b) => targetOk(b, as, env.h)); // the working folder
    return true;
  };
}

const psData = (args) => psRead(args);

// Round 7 (LOW): a wait that does not end soon holds the run without the owner seeing why. sleep (and Start-Sleep)
// up to 60 seconds in all; `sleep infinity`, `tail -f` and `Get-Content -Wait` ask.
const SLEEP_MAX_S = 60;
const SLEEP_UNIT = Object.freeze({ '': 1, s: 1, m: 60, h: 3600, d: 86400 });
const sleepSeconds = (v) => { const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(v); return m ? Number(m[1]) * SLEEP_UNIT[m[2]] : Infinity; };
const sleepCmd = (args) => args.length > 0 && args.reduce((t, a) => t + sleepSeconds(a.v), 0) <= SLEEP_MAX_S;

/** Start-Sleep N, -Seconds N, -Milliseconds N (any unique prefix): at most 60 seconds in all; -Duration and the rest ask. */
function psSleep(args) {
  let ms = 0;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    let v = args[i].v;
    let unit = 1000;
    if (v.startsWith('-')) {
      if (v.includes(':')) return false;
      if (psParam(v, 'milliseconds', 0)) unit = 1;
      else if (!psParam(v, 'seconds', 0)) return false;
      if (!args[i + 1]) return false;
      i += 1;
      v = args[i].v;
    }
    if (!/^\d+(?:\.\d+)?$/.test(v)) return false;
    ms += Number(v) * unit;
    seen = true;
  }
  return seen && ms <= SLEEP_MAX_S * 1000;
}

const PROCESS_NAME_RE = /^[A-Za-z0-9_.*?-]+$/;

/**
 * Round 5: Get-Process with its default table only (name, id, memory, CPU). A process object carries more:
 * the program path, the window title and, in PowerShell 7, the whole command line of every process (a
 * token or password given as an argument), which a later Select-Object, Format-List or ConvertTo-Json
 * prints. So nothing may read its output, and only names, -Name, -Id and -ErrorAction are taken:
 * -ComputerName (Windows PowerShell 5.1) asks another computer; -Module, -FileVersionInfo and
 * -IncludeUserName print more than the table.
 */
function psProcess(args, env) {
  if (env.afterPipe || env.toPipe) return false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    const next = args[i + 1];
    if (!v.startsWith('-')) { if (!PROCESS_NAME_RE.test(v)) return false; continue; }
    if (psParam(v, 'name', 1) || /^-processname$/i.test(v)) { if (!next || !PROCESS_NAME_RE.test(next.v)) return false; i += 1; continue; }
    if (/^-(?:id|pid)$/i.test(v)) { if (!next || !/^\d+$/.test(next.v)) return false; i += 1; continue; }
    if (/^-ea$/i.test(v) || psParam(v, 'erroraction', 6)) { if (!next || !/^(?:silentlycontinue|stop|continue|ignore)$/i.test(next.v)) return false; i += 1; continue; }
    return false;
  }
  return true;
}

// the runners: they ask while the project holds code no owner-approved run has covered
const nodeTestRun = runner(nodeTest);
const npmRun = runner(npmCmd);
const npxRun = runner(npxCmd);
const tscRun = runner(tscCmd);
const vitestRun = runner(vitestCmd);
const eslintRun = runner(eslintCmd);
const viteRun = runner(viteCmd);
const forgeRun = runner((args, env) => forgeTool(args[0], args.slice(1), env));

// Round 6: `which` and bash `type` print where a program is installed (a path on this computer); they ask.
// In a package script on Windows cmd.exe runs `type`, which prints a file: read like cat there.
const cmdType = (args, env, name) => (WIN && env.script ? content(args, env, name) : false);

// Round 7 (LOW): --files0-from reads a list of files from a file (wc, du); -c reads a list of files to hash from a file
const FILES0_RE = /^--files0-from(?:=|$)/;
const hashCheck = (v) => /^--(?:check|status|warn|strict|quiet)(?:=|$)/.test(v) || shortGroup(v).includes('c');
const hasher = reader('content', { deny: hashCheck });

const SH_COMMANDS = Object.freeze({
  // names and sizes only
  ls: lister, dir: lister, stat: lister, du: reader('list', { deny: (v) => FILES0_RE.test(v) }), df: lister, realpath: lister, readlink: lister,
  test: lister, find: findCmd,
  // file text
  cat: content, head: content, cut: content, diff: content, cmp: content, type: cmdType,
  tail: reader('content', { deny: (v) => /^--(?:follow|retry|pid|sleep-interval)(?:=|$)/.test(v) || /[fF]/.test(shortGroup(v)) }), // -f never ends
  wc: reader('content', { deny: (v) => FILES0_RE.test(v) }),
  sha256sum: hasher, sha1sum: hasher, md5sum: hasher,
  grep: searchCmd(), egrep: searchCmd(), fgrep: searchCmd(),
  rg: searchCmd({ deny: (v) => /^--(?:pre|pre-glob|search-zip|hostname-bin)(?:=|$)/.test(v) || shortGroup(v).includes('z') }), // these run programs
  // --files0-from reads a list of files to print
  sort: reader('content', { deny: (v) => /^--(?:output|compress-program|files0-from)(?:=|$)/.test(v) || (!v.startsWith('--') && shortGroup(v).includes('o')) }),
  uniq: reader('content', { maxPos: 1 }), // a second name is the output file
  sed: sedRead,
  // no file is opened
  basename: plain, dirname: plain, tr: plain, echo: plain, printf: plain, sleep: sleepCmd,
  true: plain, false: plain, pwd: noArgs, whoami: noArgs, hostname: noArgs, date: dateRead,
  cd: cdCmd, mkdir: mkdirCmd,
  git: gitCmd, node: nodeCmd, npm: npmRun, npx: npxRun, tsc: tscRun, vitest: vitestRun, eslint: eslintRun, vite: viteRun,
});

// the handlers whose plain words are paths: a sensitive name among them is a credentials card
const PATH_READERS = new Set(Object.values(SH_COMMANDS).filter((fn) => ![plain, noArgs, dateRead, sleepCmd, cdCmd, mkdirCmd, gitCmd, nodeCmd, npmRun, npxRun, tscRun, vitestRun, eslintRun, viteRun].includes(fn)));

const psNames = (names, fn) => { if (fn !== psData && fn !== psProcess) PATH_READERS.add(fn); return Object.fromEntries(names.map((k) => [k, fn])); };

// Round 5: Get-Command (gcm) is not here: its Definition and ScriptContents are the text of any script or
// profile function, also outside the project (`gcm x.ps1 | Format-List *`), so it asks.
const PS_COMMANDS = Object.freeze({
  ...psNames(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'test-path', 'resolve-path'], psReader('list')),
  ...psNames(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'get-filehash'], psReader('content')),
  ...psNames(['split-path', 'join-path', 'get-location', 'gl', 'pwd', 'measure-object', 'measure', 'select-object', 'select',
    'sort-object', 'sort', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'write-output', 'echo', 'write', 'write-host',
    'get-date', 'convertfrom-json', 'convertto-json'], psData),
  'start-sleep': psSleep, sleep: psSleep,
  // `ps` is Get-Process only on Windows; PowerShell on Linux or macOS runs the native ps (`ps aux`: every command line)
  ...psNames(WIN ? ['get-process', 'ps'] : ['get-process'], psProcess),
  cd: cdCmd, 'set-location': cdCmd, sl: cdCmd, chdir: cdCmd, mkdir: mkdirCmd,
  git: gitCmd, node: nodeCmd, npm: npmRun, npx: npxRun, tsc: tscRun, vitest: vitestRun, eslint: eslintRun, vite: viteRun,
});
