#!/usr/bin/env node
'use strict';
/**
 * forge-skill-audit.cjs — static threat scan of a CANDIDATE skill folder before the Scout adopt step (W2-H1B-SCOUT,
 * 2026-11-06; skills-audit plan item 11: "the security-auditor taxonomy as Node rules"; hardened W2-SKILLAUDIT-FIX,
 * 2026-11-07, after the Security Boss review).
 *
 * Provenance: threat taxonomy (categories and the kind of pattern per category) adapted as DATA from
 *   alirezarezvani/claude-skills, engineering/skills/skill-security-auditor (SKILL.md + references/threat-model.md),
 *   commit f11fccbb2bfada760b26b3c8d581dc7dc9984a9d, licence MIT (repo LICENSE, read 2026-11-06 via gh api).
 *   Its Python scanner (scripts/skill_security_auditor.py) was NOT read into or copied into Forge; every rule below is
 *   written in Forge's own words and regexes (PATTERN_ADAPTED). Added by Forge: Claude Code hook/settings/plugin/MCP
 *   writes, Windows persistence (schtasks, Run keys, Startup), PowerShell forms and hardcoded secret literals.
 *
 * Why a new tool and not doctor/checks-hygiene.cjs: checks-hygiene judges Forge's OWN skills (description budget, path
 * refs, vendor pins); this scans UNTRUSTED external folders before they are copied in. Mixing them would make the doctor
 * read untrusted input on every run.
 *
 * Read-only: it lstats the root and every entry (a link or junction is reported, never followed; a link root is
 * refused), opens files read-only, runs nothing and writes nothing (no write API, no child_process). Every rule runs on
 * every text file; the file kind only tunes severity (a code rule in plain doc prose is medium; in a code file, a fenced
 * block or backticks it keeps its own severity). Printed text is secret-masked and control/bidi characters are escaped
 * as \u{..}. There is no in-file suppression marker on purpose. A finding is a reason for Security Boss to read the
 * line, not proof of malice; a clean scan is not proof of safety (pattern-based, static only).
 *
 * CLI: node forge-skill-audit.cjs scan <dir> [--json]   ·   node forge-skill-audit.cjs --help
 * Exit codes (any non-zero exit stops the adopt):
 *   0 = PASS or WARN: the whole folder was scanned and no finding is high
 *   1 = FAIL: the whole folder was scanned and at least one finding is high
 *   2 = usage error, or the root is refused (missing, not a folder, a link/junction, a UNC path) before any scan
 *   3 = INCOMPLETE: part of the folder was not scanned (unreadable entry, node_modules, .git, a special file, the depth
 *       or file cap, a file over the read cap, a file that changed during the scan); wins over 1. Every such condition
 *       is also a high finding, so a caller that only reads counts.high still stops.
 * API: scanDir(dir, {fs?, maxFiles?, maxDepth?, maxReadBytes?}) -> {dir, verdict, complete, incomplete[], counts,
 *      files_scanned, truncated, findings[{rule, cls, severity, file, line, text, why}]}. `fs` is a seam for tests.
 */
const realFs = require('fs');
const path = require('path');

const MAX_FILES = 5000, MAX_DEPTH = 20, MAX_READ_BYTES = 2 * 1024 * 1024;
const LONG_LINE = 8 * 1024, TEXT_SNIPPET = 160, SNIPPET_WINDOW = 1000, MAX_PROSE_HITS = 20;
const OPEN_FLAGS = realFs.constants.O_RDONLY | (realFs.constants.O_NOFOLLOW || 0) | (realFs.constants.O_NONBLOCK || 0);

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.html', '.htm']);
const DATA_EXT = new Set(['.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml']);
const MD_EXT = new Set(['.md', '.mdx', '.markdown']);
const BIN_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.msi', '.scr', '.com', '.jar', '.class',
  '.pyc', '.pyo', '.wasm', '.o', '.a', '.lib']);
const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;
const HARMLESS_DOTFILES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.prettierignore',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintignore', '.npmignore', '.nvmrc', '.node-version', '.markdownlint.json']);
const CONFIG_FILE_RE = /^(?:settings(?:\.local)?\.json|hooks\.json|\.mcp\.json|mcp\.json|plugin\.json|marketplace\.json)$/i;

// Secrets: masked in EVERY printed text (all findings and manifest snippets), not only in SECRET-LITERAL.
const SECRET_SRC = '\\bAKIA[0-9A-Z]{16}\\b|\\bgh[pousr]_[A-Za-z0-9]{36,}\\b|\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\\b|\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----';
const SECRET_MASK_RE = new RegExp(SECRET_SRC.replace(/PRIVATE KEY-----$/, 'PRIVATE KEY-----[\\s\\S]*?(?:-----END[^-]{0,40}-----|$)'), 'g');
const KEY_BEGIN_RE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, KEY_END_RE = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;
// Hidden characters: every format character (Cf: zero-width, bidi, soft hyphen, BOM, tags) plus variation selectors
// supplement; a BOM is allowed only at byte 0 (stripped before scanning). Emoji ZWJ sequences are not hidden text.
const HIDDEN_RE = /[\p{Cf}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const EMOJI_ZWJ_RE = /(\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})/gu;
const ESCAPE_RE = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Cs}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const ENV_SECRET = '(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)';
const HOME_RE = /(?:os\.homedir\(\)|~[\\/]|\$HOME\b|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|process\.env\.(?:HOME|USERPROFILE|APPDATA)|expanduser\(|\/etc\/|C:\\\\?Windows|\.\.[\\/]|(?<![\w.-])\.claude(?:[\\/'"`]|$))/i;
const WRITE_RE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rmSync|unlinkSync|symlinkSync|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\b|\bopen\([^)\n]{0,200}['"][wa]b?\+?['"]|>>?\s*["']?(?:~|\$HOME|\/etc)/i;
const HOOKS_HARD_RE = /["'](?:hooks|mcpServers|enabledPlugins|statusLine)["']\s*:|\.git[\\/]hooks\b|\bcore\.hooksPath\b|\bclaude\s+(?:mcp\s+add|plugin\s+(?:install|enable))\b|--dangerously-skip-permissions\b|\bbypassPermissions\b/i;
const HOOKS_NAME_RE = /\bsettings(?:\.local)?\.json\b|\.claude[\\/]hooks\b|\binstalled_plugins\.json\b|\b(?:PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|SubagentStop)\b|\bhooks?\s+(?:entry|config(?:uration)?)\b/i;
const CHANGE_VERB_RE = /\b(?:add|adds|adding|write|writes|edit|edits|change|changes|modify|modifies|update|updates|append|appends|put|register|registers|insert|inject|install|installs|enable|enables|set|sets|merge|patch|overwrite)\b/i;
const SPEC_RE = /^(?:[$%]|(?:@[\w.-]+\/)?[A-Za-z0-9][\w.-]*(?:[@=<>~!^]\S*)?$)/;
const RUNNER_RE = /\b(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|bun\s+x|pipx\s+run|uv\s+tool\s+run)\b((?:[ \t]+[^\s|;&`]{1,200}){0,8})/gi;

// window(lines, i, n): line i joined with the next n lines (multi-line calls); sentence(): the sentence around line i.
const windowOf = (lines, i, n) => lines.slice(i, i + n + 1).join(' ');
const BOUNDARY_RE = /^\s*(?:$|[-*+]\s|\d+[.)]\s|#|```|~~~|\|)/;
function sentence(lines, i) {
  let pre = '', post = '';
  if (!BOUNDARY_RE.test(lines[i])) for (let k = i - 1; k >= Math.max(0, i - 3) && !BOUNDARY_RE.test(lines[k]); k--) pre = lines[k] + ' ' + pre;
  if (!/[.!?:]\s*$/.test(lines[i])) for (let k = i + 1; k <= Math.min(lines.length - 1, i + 3) && !BOUNDARY_RE.test(lines[k]); k++) { post += ' ' + lines[k]; if (/[.!?:]\s*$/.test(lines[k])) break; }
  return pre.split(/[.!?:](?=\s)/).pop() + ' ' + lines[i] + ' ' + post.split(/[.!?:](?=\s|$)/)[0];
}
const hooksChange = (line, i, lines) => HOOKS_HARD_RE.test(line) || (HOOKS_NAME_RE.test(line) && (WRITE_RE.test(line) || CHANGE_VERB_RE.test(line) || CHANGE_VERB_RE.test(sentence(lines, i))));
function runnerSpecs(line) {
  const out = [];
  RUNNER_RE.lastIndex = 0;
  // N2 (re-read 2026-11-07): no hit cap here; pinned calls must never hide an unpinned one later on the line (linear scan).
  for (let m; (m = RUNNER_RE.exec(line));) {
    const toks = m[1].trim().split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const p = toks.findIndex((x) => x === '-p' || x === '--package' || x === '--from');
    const spec = p >= 0 && toks[p + 1] ? toks[p + 1] : (toks.find((x) => !x.startsWith('-')) || '');
    if (SPEC_RE.test(spec)) out.push(spec); // a bare `npx` or `npx (no install)` names no package: not a run
  }
  return out;
}
const pinned = (spec) => /^(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec) || /^[\w.[\]-]+==\d+(?:\.\d+)*$/.test(spec);

// Each rule: id, cls, severity (high | medium | info), home ('code' | 'doc' | 'all'), re or test(line, i, lines),
// optional prose:true (also matched over the whole file with line breaks as spaces), inline / data (severity in doc
// backticks / in .json-.yaml-.toml data files) and dupOf (not reported again on a line that rule already reported).
// home only tunes severity: a 'code' rule that hits plain doc prose (outside fences and backticks) drops to medium.
const RULES = [
  // T1 code execution (threat-model T1)
  { id: 'EXEC-SHELL', cls: 'shell-exec', severity: 'high', home: 'code', why: 'runs a command through a shell (command injection surface)',
    re: /\b(?:child_process\.)?exec(?:Sync)?\s*\(|\bshell\s*:\s*true\b|\bos\.(?:system|popen)\s*\(|\bsubprocess\.\w+\([^)\n]{0,200}shell\s*=\s*True|\bInvoke-Expression\b|\biex\b\s*[(\x24]/i },
  { id: 'EXEC-EVAL', cls: 'shell-exec', severity: 'high', home: 'code', why: 'evaluates a string as code',
    re: /(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn\w*\(|(?<![.\w])exec\s*\(\s*(?:compile|base64|codecs|[a-z_]+\s*\))|\b__import__\s*\(|\bcompile\s*\([^)\n]{0,200}['"]exec['"]/ },
  { id: 'EXEC-PIPE', cls: 'shell-exec', severity: 'high', home: 'all', why: 'pipes downloaded content straight into an interpreter',
    re: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,400}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,400}\|\s*(?:iex|Invoke-Expression|python3?|node|perl|ruby)\b/i },
  { id: 'EXEC-ENCODED', cls: 'obfuscation', severity: 'high', home: 'all', why: 'runs an encoded PowerShell command (content hidden from review)',
    re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,200}\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i },
  { id: 'EXEC-INLINE', cls: 'shell-exec', severity: 'high', home: 'code', why: 'runs inline code through an interpreter flag (node -e, python -c, powershell -Command, bash -c, cmd /c)',
    re: /\b(?:node|nodejs|deno|bun|perl|ruby)(?:\.exe)?\s+(?:-{1,2}[\w-]+\s+){0,4}(?:-e|-p|--eval|--print)\b|\bpython[\d.]*(?:\.exe)?\s+(?:-[\w]+\s+){0,4}-c\b|\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-[\w]+\s+){0,6}-(?:c|command|e|ec|enc|encodedcommand)\b|\b(?:ba|z|da|k)?sh\s+(?:-[\w]+\s+){0,4}-c\b|\bcmd(?:\.exe)?\s+\/[ck]\b/i },
  { id: 'EXEC-DYNAMIC-LOAD', cls: 'shell-exec', severity: 'high', home: 'code', why: 'loads code from a computed path (what runs is decided at run time)',
    re: /(?<![.\w])require\s*\(\s*(?!['"][^'"`$\n]{0,200}['"]\s*\))(?=[^)\s])|(?<![.\w])import\s*\(\s*(?!['"][^'"`$\n]{0,200}['"]\s*\))(?=[^)\s])|\bimportlib\.import_module\s*\(\s*(?!['"][^'"\n]{0,200}['"]\s*\))(?=[^)\s])/ },
  { id: 'EXEC-DESERIALIZE', cls: 'shell-exec', severity: 'high', home: 'code', why: 'unsafe deserialization can run code',
    re: /\b(?:pickle|cPickle|marshal|dill)\.loads?\s*\(|\byaml\.load\s*\((?![^)\n]{0,200}SafeLoader)|\bunserialize\s*\(/ },
  { id: 'EXEC-SPAWN', cls: 'shell-exec', severity: 'info', home: 'code', why: 'starts a process without a shell (read what it runs)',
    re: /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(|\bsubprocess\.(?:run|call|check_output|Popen)\s*\(|\bStart-Process\b/i },
  // T2 data exfiltration: network
  { id: 'NET-CALL', cls: 'network', severity: 'high', home: 'code', why: 'makes a network call (possible exfiltration channel)',
    re: /(?<![.\w])fetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\bnet\.(?:connect|createConnection)\s*\(|\btls\.connect\s*\(|\baxios\b|\bgot(?:\.\w+)?\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\brequests\.(?:get|post|put|patch|delete|request)\s*\(|\burllib(?:\d)?\.request\b|\burlopen\s*\(|\bhttpx\.|\baiohttp\b|\bsocket\.(?:socket|connect|create_connection|gethostbyname)\s*\(|\bdns\.(?:lookup|resolve\w*)\s*\(|\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i },
  { id: 'NET-SEND-PROSE', cls: 'network', severity: 'high', home: 'doc', prose: true, why: 'tells the agent to send data somewhere',
    re: /\b(?:send|upload|post|exfiltrate|forward|transmit)\s+(?:the\s+|all\s+|any\s+|its\s+)?(?:contents?|files?|data|credentials|keys|tokens|secrets|history|conversation|env(?:ironment)?)\b[^.\n]{0,60}\b(?:to|into)\b/i },
  // T2 data exfiltration: credentials
  { id: 'CRED-PATH', cls: 'credential-access', severity: 'high', home: 'all', why: 'touches a credential file or store',
    re: /(?:~|\$HOME|%USERPROFILE%|homedir\(\))?[\\/]?\.(?:ssh|aws|gnupg|kube|docker)[\\/]|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.credentials\.json\b|\.git-credentials\b|\.netrc\b|\.pypirc\b|(?<![\w.-])\.npmrc\b|\baws[\\/]credentials\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bcmdkey\s+\/list\b|\bLogin Data\b|\bCookies\.sqlite\b/i },
  { id: 'CRED-ENV', cls: 'credential-access', severity: 'high', home: 'code', why: 'reads a secret-looking environment variable or the whole environment',
    re: new RegExp('\\bprocess\\.env\\.\\w*' + ENV_SECRET + '\\w*|\\bprocess\\.env\\[[^\\]\\n]{0,200}' + ENV_SECRET + '|\\bos\\.(?:environ\\[[^\\]\\n]{0,200}|getenv\\([^)\\n]{0,200}|environ\\.get\\([^)\\n]{0,200})' + ENV_SECRET + '|\\$env:\\w*' + ENV_SECRET + '|JSON\\.stringify\\(\\s*process\\.env\\s*\\)|\\bdict\\(\\s*os\\.environ\\s*\\)|\\bos\\.environ\\.copy\\(\\)|\\bprintenv\\b|Get-ChildItem\\s+env:', 'i') },
  { id: 'CRED-DOTENV', cls: 'credential-access', severity: 'high', home: 'code', why: 'reads a .env file',
    re: /\b(?:readFileSync|readFile|open|Get-Content|cat|type)\b[^\n]{0,40}['"`]?[^'"`\s]{0,200}\.env(?:\.\w+)?['"`]/i },
  { id: 'SECRET-LITERAL', cls: 'credential-access', severity: 'high', home: 'all', why: 'holds what looks like a hardcoded secret (text redacted)', redact: true,
    re: new RegExp(SECRET_SRC) },
  // file writes outside the skill folder and persistence (threat-model T4)
  { id: 'FS-OUTSIDE', cls: 'file-write-outside', severity: 'high', home: 'code', why: 'writes outside the skill folder (home, system, parent or .claude paths)',
    test: (line, i, lines) => WRITE_RE.test(line) && HOME_RE.test(windowOf(lines, i, 4)) },
  { id: 'FS-CLAUDE-PATH', cls: 'file-write-outside', severity: 'high', home: 'code', inline: 'medium', data: 'medium', why: 'code that names a .claude path (Claude Code config, agents, hooks or Forge tools)',
    re: /(?<![\w.-])\.claude(?:[\\/'"`]|$)/i },
  { id: 'FS-SYMLINK', cls: 'file-write-outside', severity: 'high', home: 'code', why: 'creates a link (can redirect writes outside the folder)',
    re: /\bsymlinkSync?\s*\(|\bos\.symlink\s*\(|\bln\s+-s\b|\bmklink\b|New-Item\b[^\n]{0,200}-ItemType\s+(?:SymbolicLink|Junction|HardLink)/i },
  { id: 'PERSIST', cls: 'persistence', severity: 'high', home: 'all', why: 'sets up persistence or raises privileges',
    re: /(?:^|[\\/\s'"`])\.(?:bashrc|bash_profile|zshrc|zprofile|profile)\b|\$PROFILE\b|\bauthorized_keys\b|\bcrontab\b|\/etc\/cron|\bschtasks(?:\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b|\blaunchctl\s+load\b|\bsystemctl\s+enable\b|CurrentVersion\\+Run\b|\\Start Menu\\Programs\\Startup\b|\bsudo\s+\w|\bchmod\s+(?:-R\s+)?(?:777|[ugoa]*\+s|[0-7]?4[0-7]{3})\b|\bsetuid\b/i },
  // Claude Code hooks, settings, plugins and MCP wiring (Forge addition: the gate keeps these from agents)
  { id: 'HOOKS-SETTINGS', cls: 'hooks-settings', severity: 'high', home: 'all', why: 'writes or tells the agent to change Claude Code settings, hooks, plugins, MCP servers or git hooks',
    test: hooksChange },
  { id: 'HOOKS-MENTION', cls: 'hooks-settings', severity: 'medium', home: 'all', why: 'names Claude Code settings or hook events (read whether the skill ships or changes one)',
    test: (line, i, lines) => HOOKS_NAME_RE.test(line) && !hooksChange(line, i, lines) },
  // T3 prompt injection (prose the agent will read)
  { id: 'INJECT-OVERRIDE', cls: 'prompt-injection', severity: 'high', home: 'doc', prose: true, why: 'tries to override the agent\'s instructions or identity',
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system|original|other)\s+(?:instructions?|rules|prompts?|messages|guidelines)\b|\byou\s+are\s+now\s+(?:a|an|in|the|no\s+longer)\b|\b(?:act|behave)\s+as\s+(?:root|admin(?:istrator)?|an?\s+unrestricted|DAN)\b|\bpretend\s+(?:that\s+)?(?:you\s+have|there\s+are)\s+no\s+(?:restrictions|rules|limits|guidelines)\b|\bnew\s+system\s+prompt\b/i },
  { id: 'INJECT-BYPASS', cls: 'prompt-injection', severity: 'high', home: 'doc', prose: true, why: 'tells the agent to skip safety or hide what it does',
    re: /\b(?:skip|bypass|disable|turn\s+off|ignore)\s+(?:the\s+|all\s+|any\s+)?(?:safety|security|content|permission|approval)\s*(?:checks?|filters?|filtering|prompts?|guardrails?|rules|gates?)?\b|\b(?:do\s+not|don't|never)\s+(?:tell|inform|show|mention\s+(?:this\s+)?to)\s+the\s+user\b|\bwithout\s+(?:asking|telling|informing)\s+the\s+user\b|\b(?:run|execute)\s+any\s+command\b|\bfull\s+(?:filesystem|file\s+system|disk)\s+access\b/i },
  { id: 'INJECT-HTML-COMMENT', cls: 'prompt-injection', severity: 'high', home: 'doc', whole: true, why: 'hides text in an HTML comment (invisible when rendered; any non-empty comment in Markdown, an instruction-shaped one elsewhere)',
    re: /\b(?:you\s+must|instructions?|assistant|system|always|never|run|execute)\b/i },
  { id: 'INJECT-HIDDEN-CHARS', cls: 'prompt-injection', severity: 'high', home: 'all', why: 'zero-width, bidi, tag or other format characters hide text from a human reviewer',
    test: (line) => HIDDEN_RE.test(line.replace(EMOJI_ZWJ_RE, '$1')) },
  // T5 supply chain
  { id: 'SUPPLY-INSTALL', cls: 'supply-chain', severity: 'high', home: 'code', why: 'installs packages at run time (bypasses review)',
    re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\buvx?\s+(?:pip\s+install|tool\s+install)\b|\bpipx\s+install\b|\bgem\s+install\b|\bgo\s+install\b|\bInstall-Module\b|['"](?:pip3?|npm|pnpm|yarn|pipx|uv)['"]\s*,\s*(?:['"]-m['"]\s*,\s*['"]pip['"]\s*,\s*)?['"](?:install|i|add)['"]/i },
  { id: 'SUPPLY-INSTALL-DOC', cls: 'supply-chain', severity: 'high', home: 'doc', prose: true, dupOf: 'SUPPLY-INSTALL', why: 'tells the agent to install packages (prose is what an agent runs)',
    re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-g\s+)?[@\w]|\bpip3?\s+install\s+\w|\bpipx\s+install\b|\bInstall-Module\b/i },
  { id: 'SUPPLY-RUNNER', cls: 'supply-chain', severity: 'medium', home: 'code', why: 'runs a downloaded package through a runner (pinned to an exact version; read what it runs)',
    test: (line) => { const s = runnerSpecs(line); return s.length > 0 && s.every(pinned); } },
  { id: 'SUPPLY-RUNNER-UNPINNED', cls: 'supply-chain', severity: 'high', home: 'code', why: 'runs an unpinned downloaded package (npx, pnpm dlx, bunx, uvx, pipx run): whatever is published today runs',
    test: (line) => runnerSpecs(line).some((s) => !pinned(s)) },
  // obfuscation (threat-model T1 / pattern 2)
  { id: 'OBFUSCATION', cls: 'obfuscation', severity: 'high', home: 'all', why: 'decodes or hides content (base64, hex or char-code chains)',
    re: /\batob\s*\(|Buffer\.from\([^)\n]{0,200}['"]base64['"]|\bbase64\s+(?:-d|--decode)\b|\bb64decode\s*\(|FromBase64String\b|\bcodecs\.decode\s*\(|['"`][A-Za-z0-9+/]{160,}={0,2}['"`]|(?:\\x[0-9a-fA-F]{2}){8,}|String\.fromCharCode\s*\((?:\s*\d+\s*,){3,}|(?:chr\(\d+\)\s*\+\s*){3,}/ },
];
for (const r of RULES) if (r.re && r.prose) r.reG = new RegExp(r.re.source, r.re.flags + 'g');

// Structural findings (by name, size, walk or read state). incomplete:true = part of the folder was not scanned.
const S = (cls, severity, why, incomplete) => ({ cls, severity, why, incomplete: !!incomplete });
const STRUCT = {
  'STRUCT-UNREADABLE': S('structure', 'high', 'an entry could not be read, so it was not scanned', true),
  'STRUCT-VENDORED': S('supply-chain', 'high', 'ships installed packages (node_modules) that were not scanned; remove them from the copy and rescan', true),
  'STRUCT-GIT-DIR': S('structure', 'high', 'a nested .git folder was not scanned (its hooks run on git commands inside it); remove it from the copy and rescan', true),
  'STRUCT-SPECIAL': S('structure', 'high', 'a FIFO, socket or device entry was not scanned', true),
  'STRUCT-TRUNCATED': S('structure', 'high', 'the folder was only partly scanned (file or depth cap)', true),
  'STRUCT-PARTIAL-READ': S('structure', 'high', 'only the first part of a large file was scanned', true),
  'STRUCT-CHANGED': S('structure', 'high', 'the file changed between the walk and the read (or is no longer a regular file), so it was not scanned', true),
  'STRUCT-SYMLINK': S('file-write-outside', 'high', 'a symlink or junction can point outside the skill folder'),
  'STRUCT-HIDDEN-NAME': S('prompt-injection', 'high', 'a file name holds control, bidi or other hidden characters'),
  'STRUCT-SECRET-FILE': S('credential-access', 'high', 'a secret or key file has no place in a skill'),
  'STRUCT-CONFIG-FILE': S('hooks-settings', 'high', 'ships a Claude Code settings, hook, plugin or MCP config file'),
  'STRUCT-BINARY': S('structure', 'high', 'ships an executable, compiled or binary (NUL bytes) file that cannot be reviewed'),
  'STRUCT-HARDLINK': S('structure', 'medium', 'a hard-linked file shares its content with a path outside this view'),
  'STRUCT-LONG-LINE': S('structure', 'medium', 'a line longer than ' + LONG_LINE + ' characters can hide a payload from a reviewer'),
  'STRUCT-DOTFILE': S('structure', 'info', 'an unexpected dotfile; check what it configures'),
  'STRUCT-UTF16': S('structure', 'info', 'a UTF-16 file was decoded and scanned'),
  'SUPPLY-LIFECYCLE': S('supply-chain', 'high', 'an install lifecycle script runs code the moment the package is installed'),
  'SUPPLY-BAD-MANIFEST': S('supply-chain', 'medium', 'package.json does not parse, so its scripts could not be judged'),
  'SUPPLY-DEPS': S('supply-chain', 'info', 'runtime dependencies to vet (Forge tools are zero-dependency)'),
  'SUPPLY-UNPINNED': S('supply-chain', 'info', 'an unpinned dependency can change under you'),
};

/** esc(s): control, bidi, format and lone-surrogate characters become visible \u{..} text (terminal- and JSON-safe). */
const esc = (s) => String(s).replace(ESCAPE_RE, (c) => '\\u{' + c.codePointAt(0).toString(16) + '}');
const mask = (s) => String(s).replace(SECRET_MASK_RE, '[redacted]');
function snippet(text) {
  let t = mask(String(text).trimStart().slice(0, SNIPPET_WINDOW)).trim();
  if (t.length > TEXT_SNIPPET) { t = t.slice(0, TEXT_SNIPPET); if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1); t += '…'; }
  return esc(t);
}
/** make(): the ONE place a finding is built, so masking and escaping cannot be skipped. */
function make(id, meta, severity, file, line, text, redact) {
  return { rule: id, cls: meta.cls, severity, file: esc(mask(file)), line, text: redact ? '[redacted]' : snippet(text), why: meta.why };
}
const sf = (id, file, line, text) => make(id, STRUCT[id], STRUCT[id].severity, file, line, text);
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/') || '.';

/** walk(root) -> {files[{abs, rel, name, size, dev, ino}], findings[], truncated}. lstat only: links are never followed. */
function walk(root, fsx, lim) {
  const files = [], findings = [];
  let truncated = false;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let names;
    try { names = fsx.readdirSync(dir); } catch (e) { findings.push(sf('STRUCT-UNREADABLE', rel(root, dir) + '/', 0, 'readdir: ' + (e.code || e.message))); continue; }
    for (const raw of names) {
      const name = String(raw), abs = path.join(dir, name), r = rel(root, abs);
      if (HIDDEN_RE.test(name) || /[\x00-\x1f\x7f-\x9f]/.test(name)) findings.push(sf('STRUCT-HIDDEN-NAME', r, 0, name));
      let st;
      try { st = fsx.lstatSync(abs); } catch (e) { findings.push(sf('STRUCT-UNREADABLE', r, 0, 'lstat: ' + (e.code || e.message))); continue; }
      if (st.isSymbolicLink()) { findings.push(sf('STRUCT-SYMLINK', r, 0, safeReadlink(fsx, abs))); continue; }
      if (st.isDirectory()) {
        if (name === '.git') { findings.push(sf('STRUCT-GIT-DIR', r + '/', 0, '.git/')); continue; }
        if (name === 'node_modules') { findings.push(sf('STRUCT-VENDORED', r + '/', 0, 'node_modules/')); continue; }
        if (depth + 1 > lim.maxDepth) { truncated = true; continue; }
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) { findings.push(sf('STRUCT-SPECIAL', r, 0, 'not a regular file')); continue; }
      if (files.length >= lim.maxFiles) { truncated = true; continue; }
      if (st.nlink > 1) findings.push(sf('STRUCT-HARDLINK', r, 0, st.nlink + ' links'));
      files.push({ abs, rel: r, name, size: st.size, dev: st.dev, ino: st.ino });
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, findings, truncated };
}
function safeReadlink(fsx, p) { try { return '-> ' + fsx.readlinkSync(p); } catch { return 'link'; } }

/** structural checks on one file, by name (no content). */
function structFindings(f) {
  const out = [], ext = path.extname(f.name).toLowerCase();
  if (SECRET_FILE_RE.test(f.name)) out.push(sf('STRUCT-SECRET-FILE', f.rel, 0, f.name));
  else if (f.name.startsWith('.') && !HARMLESS_DOTFILES.has(f.name)) out.push(sf('STRUCT-DOTFILE', f.rel, 0, f.name));
  if (CONFIG_FILE_RE.test(f.name)) out.push(sf('STRUCT-CONFIG-FILE', f.rel, 0, f.name));
  if (BIN_EXT.has(ext)) out.push(sf('STRUCT-BINARY', f.rel, 0, f.name));
  return out;
}

/** readFile: open read-only, fstat, compare with the walk entry (race check), read up to max bytes. */
function readFile(f, fsx, max) {
  const fd = fsx.openSync(f.abs, OPEN_FLAGS);
  try {
    const st = fsx.fstatSync(fd);
    if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.size !== f.size) return { changed: true };
    const n = Math.min(max, st.size), buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) { const k = fsx.readSync(fd, buf, off, n - off, off); if (!k) break; off += k; }
    return { buf: buf.subarray(0, off), partial: st.size > off };
  } finally { fsx.closeSync(fd); }
}
/** decode(buf) -> {text, utf16} or null for binary. UTF-16 LE/BE (by BOM) is decoded; a UTF-8 BOM at byte 0 is dropped. */
function decode(buf) {
  let text, utf16 = false;
  if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) {
    let b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    if (buf[0] === 0xFE) b.swap16();
    text = b.toString('utf16le'); utf16 = true;
  } else {
    if (buf.subarray(0, 8192).includes(0)) return null;
    text = buf.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.slice(0, 8192).includes('\u0000') ? null : { text, utf16 };
}
function kindOf(name, text) {
  const ext = path.extname(name).toLowerCase();
  if (/^#!/.test(text)) return 'code';
  if (DOC_EXT.has(ext) || name.toUpperCase() === 'SKILL.MD') return 'doc';
  return DATA_EXT.has(ext) ? 'data' : 'code';
}
function tuned(rule, ctx) {
  if (ctx === 'data') return rule.data || rule.severity;
  if (ctx === 'code' || rule.home !== 'code') return rule.severity;
  if (ctx === 'inline') return rule.inline || rule.severity;
  return rule.severity === 'high' ? 'medium' : rule.severity;
}
const hit = (rule, s, i, lines) => (rule.test ? rule.test(s, i, lines) : rule.re.test(s));

/** contentFindings(f) -> findings for one regular file: read, decode, line rules, whole-file rules, manifests. */
function contentFindings(f, fsx, lim) {
  if (BIN_EXT.has(path.extname(f.name).toLowerCase())) return [];
  let rd;
  try { rd = readFile(f, fsx, lim.maxReadBytes); } catch (e) { return [sf('STRUCT-UNREADABLE', f.rel, 0, 'read: ' + (e.code || e.message))]; }
  if (rd.changed) return [sf('STRUCT-CHANGED', f.rel, 0, 'fstat differs from the walk')];
  const out = [];
  if (rd.partial) out.push(sf('STRUCT-PARTIAL-READ', f.rel, 0, 'first ' + rd.buf.length + ' of ' + f.size + ' bytes scanned'));
  const dec = decode(rd.buf);
  if (!dec) return out.concat(sf('STRUCT-BINARY', f.rel, 0, f.name));
  if (dec.utf16) out.push(sf('STRUCT-UTF16', f.rel, 0, f.name));
  const { text } = dec, kind = kindOf(f.name, text), seen = new Map();
  const lines = text.split(/\r\n|\r|\n/);
  const add = (rule, sev, i, shown) => {
    const k = rule.id + ':' + i, dup = rule.dupOf && seen.get(rule.dupOf + ':' + i);
    if (dup && RANK[dup] <= RANK[sev]) return; // the other rule already reported this line at least as severe
    if (!seen.has(k)) { seen.set(k, sev); out.push(make(rule.id, rule, sev, f.rel, i + 1, shown, rule.redact)); }
  };
  let fence = null, inKey = false;
  lines.forEach((line, i) => {
    let ctx = kind === 'data' ? 'data' : 'code';
    if (kind === 'doc') {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; }
      ctx = m || fence ? 'code' : 'prose';
    }
    if (line.length > LONG_LINE) out.push(sf('STRUCT-LONG-LINE', f.rel, i + 1, line.length + ' characters'));
    const keyLine = inKey || KEY_BEGIN_RE.test(line);
    if (KEY_BEGIN_RE.test(line)) inKey = !KEY_END_RE.test(line.slice(line.search(KEY_BEGIN_RE) + 10));
    else if (inKey && KEY_END_RE.test(line)) inKey = false;
    const shown = keyLine && !KEY_BEGIN_RE.test(line) ? '[redacted: private key block]' : line;
    const spans = ctx === 'prose' ? (line.match(/`[^`\n]{1,500}`/g) || []).join(' ') : '';
    for (const rule of RULES) {
      if (rule.whole) continue;
      if (ctx === 'prose' && rule.home === 'code' && spans && hit(rule, spans, i, lines)) add(rule, tuned(rule, 'inline'), i, shown);
      else if (hit(rule, line, i, lines)) add(rule, tuned(rule, ctx), i, shown);
    }
  });
  wholeFileFindings(f, text, add);
  if (f.name === 'package.json') out.push(...packageJsonFindings(f, text));
  if (/^requirements.*\.txt$/i.test(f.name)) out.push(...requirementsFindings(f, lines));
  return out;
}
/** whole-file rules: prose rules matched with line breaks as spaces, and HTML comments of any length. */
function wholeFileFindings(f, text, add) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1); }
  const lineAt = (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo; };
  const flat = text.replace(/[\r\n]/g, ' ');
  for (const rule of RULES.filter((r) => r.reG)) {
    rule.reG.lastIndex = 0;
    for (let m, n = 0; (m = rule.reG.exec(flat)) && n < MAX_PROSE_HITS; n++) { add(rule, rule.severity, lineAt(m.index), m[0]); if (!m[0]) rule.reG.lastIndex++; }
  }
  const rule = RULES.find((r) => r.id === 'INJECT-HTML-COMMENT'), md = MD_EXT.has(path.extname(f.name).toLowerCase()) || f.name.toUpperCase() === 'SKILL.MD';
  // N1 (re-read 2026-11-07): only REPORTED comments count toward the cap, and an overflow is itself a high finding,
  // so a run of empty comments can never push a real one out of view.
  for (let at = text.indexOf('<!--'), n = 0; at >= 0;) {
    const end = text.indexOf('-->', at + 4), body = text.slice(at + 4, end < 0 ? text.length : end).trim();
    if (body && (md || rule.re.test(body))) {
      if (n >= MAX_PROSE_HITS) { add(rule, rule.severity, lineAt(at), 'more HTML comments with text follow that were not listed (cap ' + MAX_PROSE_HITS + ')'); break; }
      add(rule, rule.severity, lineAt(at), '<!-- ' + body.replace(/\s+/g, ' ') + (end < 0 ? ' (never closed)' : ' -->'));
      n++;
    }
    at = end < 0 ? -1 : text.indexOf('<!--', end + 3);
  }
}
function packageJsonFindings(f, text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return [sf('SUPPLY-BAD-MANIFEST', f.rel, 0, 'package.json')]; }
  const out = [], scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preuninstall', 'postuninstall']) {
    if (typeof scripts[hook] === 'string') out.push(sf('SUPPLY-LIFECYCLE', f.rel, 0, hook + ': ' + scripts[hook]));
  }
  const names = Object.keys(Object.assign({}, pkg && pkg.dependencies, pkg && pkg.optionalDependencies));
  if (names.length) out.push(sf('SUPPLY-DEPS', f.rel, 0, names.length + ': ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '')));
  return out;
}
function requirementsFindings(f, lines) {
  const out = [];
  lines.forEach((l, i) => { const s = l.replace(/#.*/, '').trim(); if (s && !s.startsWith('-') && !/==/.test(s)) out.push(sf('SUPPLY-UNPINNED', f.rel, i + 1, s)); });
  return out;
}

const RANK = { high: 0, medium: 1, info: 2 };
const refuse = (msg) => Object.assign(new Error(msg), { code: 'REFUSED' });
const UNC_RE = /^(?:\\\\|\/\/)/;
/** scanDir(dir, opts) -> report. Throws (code REFUSED or an fs code) when the root is not a plain readable folder. */
function scanDir(dir, opts = {}) {
  const fsx = opts.fs || realFs;
  const lim = { maxFiles: opts.maxFiles || MAX_FILES, maxDepth: opts.maxDepth || MAX_DEPTH, maxReadBytes: opts.maxReadBytes || MAX_READ_BYTES };
  const raw = String(dir || '');
  if (!raw) throw refuse('no folder given');
  if (UNC_RE.test(raw)) throw refuse('a UNC or device path is refused (copy the skill to a local folder first)');
  const root = path.resolve(raw);
  if (UNC_RE.test(root)) throw refuse('a UNC or device path is refused (copy the skill to a local folder first)');
  const st = fsx.lstatSync(root);
  if (st.isSymbolicLink()) throw refuse(esc(root) + ' is a link or junction; scan the real folder, never through a link');
  if (!st.isDirectory()) throw refuse(esc(root) + ' is not a folder');
  const w = walk(root, fsx, lim);
  const findings = w.findings.slice();
  for (const f of w.files) findings.push(...structFindings(f), ...contentFindings(f, fsx, lim));
  if (w.truncated) findings.push(sf('STRUCT-TRUNCATED', '.', 0, 'more than ' + lim.maxFiles + ' files or deeper than ' + lim.maxDepth));
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = { high: 0, medium: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const incomplete = [...new Set(findings.filter((f) => STRUCT[f.rule] && STRUCT[f.rule].incomplete).map((f) => f.rule))];
  const verdict = incomplete.length ? 'INCOMPLETE' : counts.high ? 'FAIL' : counts.medium ? 'WARN' : 'PASS';
  return { dir: esc(root), verdict, complete: !incomplete.length, incomplete, counts, files_scanned: w.files.length, truncated: w.truncated, findings };
}

const HELP = 'usage: forge-skill-audit.cjs scan <dir> [--json]\n'
  + 'exit codes (any non-zero exit stops the adopt):\n'
  + '  0 = PASS/WARN: whole folder scanned, no high finding\n'
  + '  1 = FAIL: whole folder scanned, at least one high finding\n'
  + '  2 = usage error, or the root is refused (missing, not a folder, a link/junction, a UNC path)\n'
  + '  3 = INCOMPLETE: part of the folder was not scanned (unreadable, node_modules, .git, special file, caps, read cap, changed); wins over 1\n';
function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  if (args[0] !== 'scan' || !args[1] || args.length > 2) { process.stderr.write(HELP); return 2; }
  let r;
  try { r = scanDir(args[1]); } catch (e) { process.stderr.write('forge-skill-audit: cannot scan ' + esc(args[1]) + ': ' + esc(e.code === 'REFUSED' ? e.message : (e.code || e.message)) + '\n'); return 2; }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write('skill audit ' + r.verdict + ': ' + r.dir + ' (' + r.files_scanned + ' files; high ' + r.counts.high + ', medium ' + r.counts.medium + ', info ' + r.counts.info + ')\n');
    if (!r.complete) process.stdout.write('NOT FULLY SCANNED (' + r.incomplete.join(', ') + '): fix the copy and rescan before anyone reviews it.\n');
    for (const f of r.findings) process.stdout.write('  ' + f.severity.toUpperCase() + ' [' + f.rule + '] ' + f.file + (f.line ? ':' + f.line : '') + ' — ' + f.why + '\n      ' + f.text + '\n');
    if (r.verdict !== 'PASS') process.stdout.write('A finding is a line for Security Boss to read, not proof of malice; a PASS is not proof of safety.\n');
  }
  return r.complete ? (r.counts.high ? 1 : 0) : 3;
}

module.exports = { scanDir, RULES, STRUCT, esc, mask };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
