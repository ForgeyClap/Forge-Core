// Forge gateway: may this permission card be approved without the owner? (WP-AUTONOMY-GW, owner decision R-0203)
//
// With autonomy on, a card whose code is 'routine' is allowed at once (permissions/store.mjs); every other
// code waits for the owner. Since fix round 2 (security review rv-autonomy-sec-2) the decision is an
// ALLOW-LIST: 'routine' needs BOTH layers to agree.
//   A. this file's block list (below) finds no hard gate: push, deploy, spend, outbound/publish,
//      credentials or sign-in, production, destructive deletes, settings, plugin or gate-code writes,
//      writes or runs outside the project folder. It names the reason the owner sees.
//   B. allow-list.mjs proves the card safe: a read-only tool, an edit inside the project, or a shell
//      command made only of known programs with simple literal arguments. Anything it cannot fully read
//      is 'not_allowlisted' (hard: true): it waits, and the owner answers it on the PC or the phone.
// The block list alone was beaten twice (H1, H2 of rv-autonomy-sec-2); it is the second layer now.
//
// Block-list layers, first match wins:
//   1. text: secret files, secret variables, secret-shaped literals, the gateway token header;
//   2. a quote-aware read of the shell command (shell-lex.mjs): every command in it (also inside `bash -c`,
//      `cmd /c`, `powershell -Command`, `npx`, `$( )`, back-ticks, script blocks) against fixed rules;
//   3. Forge's own hard-gate classifier (forge-actiongate.cjs over hard-gates.json), the same one the
//      phone ask filter uses; when it does not load, every shell card is a hard gate.
//
// What it is NOT: a sandbox. A script the agent wrote and then runs (`node tool.js`) can still do
// anything; the PreToolUse gate hook and the agents' hard-gate rules stay the other layers. It reads
// what a command says, the way an honest agent writes it; deliberate obfuscation is out of scope
// beyond the cheap tripwires below (eval, encoded commands, a dynamic program name, piping into a shell,
// an escaped letter or a brace expansion in a program or sub-command word, an unknown git sub-command).
//
// Security review rv-autonomy-sec added: every write target is read (also `${HOME}`,
// `$HOME`, `\Users\...` and `/Users/...`), links inside the project are followed to where they really
// point, inline `node -e`/`python -c` code that writes or uploads is judged, grouped curl options and
// shortened PowerShell parameters are read, a network share (UNC) is outbound, and the scripts the
// project's hooks run (with every module they require) count as gate code.
// Escalation round (four reviews of a NAME-based read gate): the read side is structural now.
// A read is approved only when its REAL location (links, junctions and Windows 8.3 short names followed)
// is inside the project or the OS temp folder, is not a sensitive file, and - for a search or a folder -
// cannot reach one (readProblem and reach below; allow-list.mjs asks them for every read target). This
// knowingly narrows owner choice R-0203, under which a read outside the project was routine.
// Verify round 6: writes of files a hook runs (goat-gate*.json, forge-dashboard code) and of
// instructions a later session loads (.claude/rules, the routing table) are settings; a write of a file that
// runs code later by itself or instructs another agent or editor is 'auto_run' (AUTO_RUN_RE); more
// credential-named files (CRED_NAME_RE) and everything inside .git are sensitive; a test runner, build, lint or
// typecheck after a routine write of code asks ('wrote_code': codeWritten, kept by store.mjs; codeWriteTargets).
// Verify round 8: an Agent or Task call names where and with what permissions a subagent runs (judgeDispatch;
// dispatchFolder tells the store where that subagent works); a WebSearch query that may carry data asks; codeWritten may
// be a function of the runner family; more programs count as writing code (codeRewriter) or as writing it when they run
// (postRunWrites: an owner-approved package script or vite build); mise, .tool-versions, bunfig, cargo config and git
// hooks are 'auto_run'.
// File system: read only, and never on a network path: real locations of read and write targets
// (remote/real-location.mjs), the folders a search would read (bounded, a big walk cached 2 s) and the hook
// scripts named in the settings files (cached 30 s).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../redact.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { actionGateClassifier } from '../remote/ask-gate.mjs';
import { realLocation } from '../remote/real-location.mjs';
import { lexCommand, PS_STRING } from './shell-lex.mjs';
import { allowListed, isLoopbackHost, webSearchProblem, ownFields, driveRelative } from './allow-list.mjs';

export const HARD_GATE_REASONS = Object.freeze({
  routine: 'Routine: geen harde poort',
  push: 'Stuurt code naar internet (git push)',
  publish: 'Publiceert of deelt iets buiten deze computer (publish, release, merge)',
  production: 'Zet iets live, raakt productie of kan geld kosten (deploy, cloud)',
  outbound: 'Stuurt gegevens of berichten naar een andere computer',
  credentials: 'Raakt wachtwoorden, sleutels of inloggegevens',
  settings: 'Wijzigt Claude Code-instellingen, plugins of de Forge-poort zelf',
  delete: 'Verwijdert bestanden of gooit werk weg',
  outside_folder: 'Schrijft of werkt buiten de projectmap',
  unjudgeable: 'Forge kan deze opdracht niet goed lezen (verborgen of samengesteld)',
  unknown_tool: 'Onbekend hulpmiddel: Forge kan niet beoordelen wat het doet',
  classifier_unavailable: 'De Forge-poortcontrole kon niet laden',
  hard_gate: 'Valt onder een harde Forge-poort',
  not_allowlisted: 'Staat niet op de lijst van veilige stappen; Forge kan niet bewijzen dat dit veilig is, dus het wacht op jou.',
  auto_run: 'Wijzigt een bestand dat later vanzelf code draait of een AI-agent of editor instructies geeft (scripts, hooks, test- en buildinstellingen, agentregels)',
  wrote_code: 'Draait tests of een build nadat er in dit project code is geschreven die jij nog niet zag draaien. Forge kan niet zien wat die code doet, dus het wacht op jou.',
  first_runner: 'Eerste keer tests of een build draaien in deze map sinds Forge startte. Forge weet niet welke code er al stond, dus het wacht één keer op jou.',
});

// forge-actiongate gate id -> code above
const ACTION_GATE_CODES = Object.freeze({
  'git-push': 'push', deploy: 'production', spend: 'production', 'dns-change': 'production', 'prod-activate': 'production',
  'workflow-activate': 'production', 'credential-attach': 'credentials', 'credential-rotate': 'credentials', 'secret-print': 'credentials',
  'outbound-sms': 'outbound', 'data-delete': 'delete', 'destructive-delete': 'delete', 'git-destructive': 'delete',
  'plugin-install': 'settings', 'plugin-install-command': 'settings', 'settings-edit': 'settings', 'settings-edit-command': 'settings',
  'opaque-exec': 'unjudgeable', 'write-outside-root': 'outside_folder',
});

const MAX_COMMAND_CHARS = 8000;
const MAX_DEPTH = 4;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
// Tools whose effect stays inside what Claude Code already does on this computer.
const ROUTINE_TOOLS = new Set(['WebSearch', 'TodoWrite', 'Task', 'Agent', 'Skill', 'ToolSearch', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'mcp__forge-ask__ask_owner']);

// H1 (round-3): one source for credential-grade files. Beyond the write-side protection it now also
// names the account/config files that hold tokens (~/.claude.json, .mcp.json), DB password files
// (.pgpass, .my.cnf), token/password/secret-named data files and the known browser credential stores.
// credentialPath is scanned over whole command text (credentialText), so it must not match a JS
// property such as `state.key`; a bare *.key / *.keyfile lives in PRIVATE_KEY_RE (single paths only).
// Round 7 (H2): `.env` with ANY suffix chain (.env.production.local, .env.local.bak, .env~, .env-backup, .env_backup,
// .env.local.1, .vercel/.env.development.local) is a dotenv file or a copy of one; only a chain that ends in
// example, sample, template, dist or default(s) (.env.example, .env.local.example) is a template without values.
const CREDENTIAL_RE = /(?:^|[/\s"'=:,(])(?:\.env(?![.~_-](?:[\w-]+\.)*(?:example|sample|template|dist|defaults?)(?=$|[/\s"'),;|&>]))(?:[.~_-][\w.~-]*)?|\.envrc|\.yarnrc\.yml|\.npmrc|\.pypirc|_?netrc|\.netrc|\.git-credentials|\.?credentials\.json|\.claude\.json|\.mcp\.json|\.pgpass|\.my\.cnf|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[\w.-]+\.(?:pem|p12|pfx|jks|keystore)|[\w.-]*(?:secret|token|password|passwd|apikey|api[_-]?key|credential)[\w.-]*\.(?:txt|json|ya?ml|ini|cfg|conf|env)|logins\.json|cookies\.sqlite|signons\.sqlite|key[0-9]\.db|\.kube\/config|\.docker\/config\.json|\.cargo\/credentials(?:\.toml)?|rclone\.conf|credentials\.tfrc\.json)(?=$|[/\s"'),;|&>])/;
// A bare private-key file name. Checked ONLY for a single path value (a Read/Grep/Glob target or one
// argument token), never over whole command text, because `obj.key` is a common property access.
const PRIVATE_KEY_RE = /(?:^|[/\s"'=:,(])[\w.-]+\.(?:key|keyfile)(?=$|[/\s"'),;|&>])/;
// F5 (escalation round): `prod.env`, `local.env`: an env file with a name in front. Single path values
// only, like PRIVATE_KEY_RE, because `process.env` is ordinary code text. Example files stay readable.
// Round 7 (H2): and its copies (`prod.env.local`, `prod.env.bak`, `prod.env~`, `prod.env_backup`).
const ENV_FILE_RE = /(?:^|[/\s"'=:,(])(?!(?:example|sample|template|dist|defaults?)\.env(?:$|[/\s"'),;|&>]))[\w-][\w.-]*\.env(?:\.(?:local|bak|old|orig|save|backup|copy|txt|tmp|\d+)|~|[_-](?:backup|bak|old|copy|local|\d+))*(?=$|[/\s"'),;|&>])/;
// F5: Chromium keeps passwords and cookies in files with plain names ("Login Data", "Local State",
// "Cookies"). They are anchored on the path separator in front (and Cookies on its profile folder), so
// the words `local state` or `cookies` in a command or a commit message are not a credential.
const BROWSER_STORE_RE = /\/(?:login data(?: for account)?|local state|web data)(?:-journal)?(?=$|[/\s"'),;|&>])|\/(?:default|profile \d+|guest profile|network)\/cookies(?:-journal)?(?=$|[/\s"'),;|&>])/;
// folders that hold credentials: anything under them (F7: a folder entry ending in `/` followed by the
// separator lookahead above could never match a real path, so they live here; L3 of rv-autonomy-sec-2
// added the GitHub CLI and Vercel CLI folders of Windows %APPDATA%)
const CREDENTIAL_DIR_RE = /(?:^|[/\s"'=:,(])(?:(?:\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.config\/gh|\.config\/gcloud|roaming\/gcloud|microsoft\/(?:credentials|protect|vault)|github cli|com\.vercel\.cli)(?=$|[/\s"'),;|&>])|secrets\/)/;
const SECRET_VAR_RE = /(?:\$(?:env:)?\{?|%)[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
// M4 (rv-autonomy-sec-2): .claude/FORGE_CONFIG.json holds the gate-hook switch; M7: anything under .git
// (config, hooks) decides what a later `git status` or `git commit` runs; M5: the whole gateway source is gate code;
// round 11b (L1): also a packaged copy at any depth under command-center, and the whole desktop/dist build output.
const SETTINGS_RE = /(?:^|[/=:])\.claude\/(?:[^/\s]*\/)*settings[^/\s]*\.json$|(?:^|[/=:])\.mcp\.json$|(?:^|[/=:])\.claude\.json$|(?:^|[/=:])\.claude\/(?:plugins|hooks)(?:\/|$)|(?:^|\/)forge-gate-hook\.cjs$|(?:^|\/)hard-gates\.json$|(?:^|\/)\.forge\/permissions(?:\/|$)|(?:^|[/=:])\.claude\/forge_config\.json$|(?:^|\/)\.git(?:\/|$)|(?:^|\/)command-center\/(?:[^/]+\/)*gateway\/(?:src\/|bin\.mjs$|supervisor\.mjs$)|(?:^|\/)command-center\/desktop\/dist(?:\/|$)/;
// H1 (round-3): the config/settings files whose CONTENTS can expose tokens, env values or account data.
// Reading one (Read/Grep/Glob tool, or a reader in the allow-list) is a `credentials` gate. This is the
// read-sensitive subset of SETTINGS_RE: it deliberately excludes gate CODE (the gateway source, hook
// scripts, hard-gates.json, plugins/hooks, .git) — reading code leaks no secret and agents read it
// routinely; those stay WRITE-gated only (SETTINGS_RE / GATE_WRITE_RE via gateKind). .claude.json and
// .mcp.json are covered by CREDENTIAL_RE above, so a shell read of them is caught on any mention too.
// Escalation round: .git/config can hold a token inside a remote URL.
const CONFIG_READ_RE = /(?:^|[/=:])\.claude\/(?:[^/\s]*\/)*settings[^/\s]*\.json(?=$|[/\s"'),;|&>])|(?:^|[/=:])\.claude\/forge_config\.json(?=$|[/\s"'),;|&>])|(?:^|[/=:])\.git\/config(?=$|[/\s"'),;|&>])/;
// L1 (round-3): writes under these folders change what Forge runs or how it is configured, so they are
// settings-class even when the exact file is not in a hook's require() closure. Used ONLY for a write
// target (gateKind); reading or RUNNING a file there is never a settings gate (the k===script skip
// in pathRule), so `node .claude/forge-bin/<tool>` and reading a command file stay routine.
// F4 (escalation round): a skill (its SKILL.md frontmatter grants tools), an agent file (tools, hooks,
// permissionMode) and an output style change what runs, not only the scripts inside a skill.
const GATE_WRITE_RE = /(?:^|[/=:])\.claude\/(?:forge-bin|commands|skills|agents|output-styles)(?:\/|$)/;
// Round 5: a CLAUDE.md or CLAUDE.local.md in the project (any folder: Claude Code loads the ones on the way
// to a file it works on) is what every later session is told, so writing one is settings-class. One
// outside the project keeps its outside_folder reason (gateKind checks that it is inside).
const CLAUDE_MD_RE = /(?:^|\/)claude(?:\.local)?\.md$/;
// Round 6 (HIGH-1, MEDIUM-3): Forge and GOAT files a hook RUNS or takes a command from (the Stop gate runs the
// "command" of .claude/goat-gate.json; agents and the doctor run .claude/forge-dashboard/log-event.cjs; the
// schema holds the default of the gate-hook switch), and what a later session is told (.claude/rules/**,
// the routing table, the session state). Settings-class, at any depth, in any letter case.
// Round 7 (M4, LOW): Claude Code's preview launcher (.claude/launch.json runs its dev-server commands) and status line
// script, the dashboard's config and the local Forge config; and everything under .claude/config (agents, tool policy,
// default skills, packs, MCP grants, hard rules: one rule instead of a list that misses the next file); and the
// durable scheduled prompts (.claude/scheduled_tasks.json), which a later session runs by itself.
const FORGE_GATE_RE = /(?:^|[/=:])\.claude\/(?:goat-gate[^/]*\.json|forge-dashboard\/[^/]+\.(?:c?js|mjs|ts|ps1|sh|bat|cmd)|forge-dashboard\/config\.json|forge_model_routing\.json|forge_session_state\.json|forge_config\.local\.json|config\/.+|launch\.json|statusline[^/]*|scheduled_tasks\.json)$|(?:^|[/=:])\.claude\/rules(?:\/|$)/;
// Round 6 (MEDIUM-3, LOW, HIGH-2): a file that makes code run later by itself or instructs another agent or an
// editor: other agents' rule files, editor tasks and MCP servers, git hooks and their managers, CI, the files a
// build, an install or a test session runs, and the config of the test runners on the allow-list. Only inside
// the project (one outside keeps its outside_folder reason). Code 'auto_run'.
const AUTO_RUN_RE = new RegExp('(?:^|/)(?:' + [
  'agents\\.md', 'gemini\\.md', '\\.cursorrules', '\\.windsurfrules', '\\.clinerules(?:/.*)?', '\\.(?:cursor|codex|gemini|windsurf)/.*',
  '\\.github/(?:copilot-instructions\\.md|instructions/.*|workflows/.*)', '\\.vscode/(?:mcp|tasks|launch|settings)\\.json',
  '\\.devcontainer/.*', '\\.idea/.*', // initializeCommand runs on this PC; JetBrains run configurations and tools
  '\\.husky/.*', '\\.githooks/.*', '\\.?lefthook(?:-local)?\\.ya?ml', '\\.pre-commit-config\\.ya?ml',
  '(?:gnu)?makefile', 'package\\.json', 'setup\\.py', 'conftest\\.py', '(?:site|user)customize\\.py', '(?:pre|post)install\\.[cm]?js',
  '\\.pnpmfile\\.c?js', '\\.yarn/plugins/.*', '\\.yarnrc',
  '(?:vitest|vite|jest|webpack|babel|rollup)\\.config\\.(?:[cm]?[jt]sx?|json)', 'vitest\\.workspace\\.(?:[cm]?[jt]s|json)',
  'eslint\\.config\\.[cm]?[jt]s', '\\.eslintrc(?:\\.(?:c?js|json|ya?ml))?', '\\.babelrc(?:\\.(?:c?js|json))?', '\\.mocharc(?:\\.(?:c?js|json|jsonc|ya?ml))?',
  // the rule and config files of other agents and editors
  'agent\\.md', 'codex\\.md', 'qwen\\.md', 'conventions\\.md', '\\.aider\\.conf\\.ya?ml', '\\.(?:continue|roo|kiro|amazonq|trae|junie|zed)/.*', '\\.roorules',
  '\\.rules', '\\.github/(?:prompts|chatmodes|agents)/.*', '\\.devcontainer\\.json', '\\.claude-plugin/.*',
  // Forge's memory and planning stores, which the next session or Boss reads as its instructions. Forge's
  // own end-of-run path (forge-run-file.cjs append, allow-list.mjs) only adds to them and stays routine.
  '\\.claude/(?:forge_[^/]*\\.md|agent-memory/.*|forge-(?:prd|tickets|vault)/.*)',
  // round 7 (LOW): CI, build, release and deploy files: a pipeline, a container build or a host runs them later
  '\\.gitlab-ci\\.ya?ml', '\\.circleci/.*', 'azure-pipelines\\.ya?ml', 'jenkinsfile', '\\.travis\\.ya?ml', 'bitbucket-pipelines\\.ya?ml', '\\.?appveyor\\.ya?ml',
  '\\.github/actions/.*', 'netlify\\.toml', 'vercel\\.json', 'render\\.ya?ml', 'fly\\.toml', 'procfile',
  'amplify\\.ya?ml', 'serverless\\.ya?ml', 'wrangler\\.toml', 'firebase\\.json', 'app\\.ya?ml', // the same for AWS Amplify, Serverless, Cloudflare, Firebase, App Engine
  '(?:.*/)?site-packages/[^/]*\\.pth', // python runs the import lines of a .pth file in site-packages at every start
  '(?:[\\w.-]+\\.)?dockerfile(?:\\.(?!md$|txt$)[\\w.-]+)?', '(?:docker-)?compose(?:[.-][\\w.-]+)?\\.ya?ml', 'gradlew(?:\\.bat)?', 'gradle-wrapper\\.properties', '\\.mvn/.*', 'mvnw(?:\\.cmd)?',
  '\\.lintstagedrc(?:\\.(?:[cm]?js|json|ya?ml))?', 'lint-staged\\.config\\.[cm]?js', '\\.releaserc(?:\\.(?:[cm]?js|json|ya?ml))?', 'release\\.config\\.[cm]?js',
  '\\.nycrc(?:\\.(?:json|ya?ml))?', 'directory\\.build\\.(?:props|targets)', 'taskfile\\.ya?ml', '\\.?justfile', '[^/]*\\.code-workspace',
  // round 8 (LOW): mise runs the hooks and tasks of its config when a shell enters the folder and picks the tools from
  // .tool-versions; bun loads the preload scripts of bunfig.toml before every `bun test`; cargo runs the runner and
  // wrapper programs of .cargo/config.toml
  '\\.?mise(?:\\.[\\w-]+)?\\.toml', '\\.config/mise(?:\\.toml|/.*)', '\\.mise/.*', '\\.tool-versions', '\\.?bunfig\\.toml', '\\.cargo/config(?:\\.toml)?',
].join('|') + ')$');
// Round 8 (LOW): a git hook runs by itself at the next commit, checkout or push: 'auto_run' (it was 'settings' through
// the .git rule of SETTINGS_RE, which still covers the rest of .git).
const GIT_HOOK_RE = /(?:^|\/)\.git\/hooks(?:\/|$)/;
// Round 6 (MEDIUM-4): files named for the secrets they hold, beyond CREDENTIAL_RE. Single path values only
// (`token`, `*.db` would be ordinary words in command text). A bare name matches only as the last part, so a
// folder of design tokens (src/tokens/x.ts) is not one.
const CRED_NAME_RE = new RegExp('(?:^|/)(?:' + [
  'service[-_]?account[\\w.-]*\\.json', 'firebase-adminsdk[\\w.-]*\\.json', 'google-services\\.json', 'googleservice-info\\.plist', 'secrets?\\.plist',
  '[\\w.-]*\\.tfvars(?:\\.json)?', '[\\w.-]*\\.tfstate(?:\\.backup)?', 'wp-config\\.php', '\\.htpasswd', '\\.dockercfg', '\\.s3cfg',
  '\\.?vault[_-]pass(?:word)?(?:\\.\\w+)?', '\\.m2/settings(?:-security)?\\.xml', 'config/database\\.ya?ml',
  'appsettings\\.(?:[\\w-]+\\.)?prod(?:uction)?\\.json', 'application-prod(?:uction)?\\.(?:properties|ya?ml)', 'local\\.settings\\.json',
  '(?:keystore|gradle|local)\\.properties', 'nuget\\.config', '\\.gitconfig', 'known_hosts(?:\\.old)?',
  '\\.?(?:credentials|token|apikey|api[_-]key|secret|password|passwd)', '[\\w.-]*\\.env\\.(?:txt|bak|old|orig|save|backup|copy)',
  '[\\w.-]*\\.(?:kdbx|ppk|pkcs12|p12|cer|crt|der|gpg|asc|sqlite3?|db|sql|dump)',
  '\\.[\\w-]*_history', '\\.history', '\\.lesshst', '\\.viminfo', 'fish_history', 'consolehost_history\\.txt',
  // kubernetes, cloud, tunnel, package-manager and database login files, wallets, bare token files
  'kubeconfig(?:\\.ya?ml)?', '[\\w.-]+\\.kubeconfig', '\\.dev\\.vars(?:\\.[\\w-]+)?', '[\\w.-]*\\.p8', 'ngrok\\.ya?ml', '\\.sentryclirc', '\\.terraformrc',
  'terraform\\.rc', '\\.boto', '\\.bundle/config', 'pip\\.(?:conf|ini)', 'pgpass\\.conf', '\\.mylogin\\.cnf', '\\.oci/config', 'wallet\\.dat',
  '(?:access|refresh|id)_token', '\\.tokens', 'htpasswd', 'g?shadow',
  // round 7 (the probe's own extra names): bare secret files, VPN/RDP/signing profiles, 2FA recovery codes and wallet
  // seeds, database and cache configs that hold a password, local override configs, dotenv look-alikes and the shell
  // profiles that export tokens. Bare names only (no extension), so a component folder such as reset_password is not one.
  '\\.?secrets', '\\.[\\w-]*(?:secret|token|password|passwd)s?', '[\\w.-]*_(?:secret|token|apikey|key)s?', '[\\w.-]+-secrets?',
  '[\\w.-]*\\.(?:ovpn|rdp|creds?|mobileprovision|provisionprofile)', 'keystore', 'credentials\\.yml\\.enc', '(?:recovery|backup)[-_]?codes?(?:\\.txt)?',
  '(?:seed|mnemonic)(?:[-_]?phrase)?\\.txt', 'my\\.(?:ini|cnf)', 'redis\\.conf', '(?:local_settings|settings_local)\\.py', 'config\\.local\\.json',
  'config/(?:local|production|prod)\\.ya?ml', '(?:env/\\.?|env\\.)(?:local|prod|production|development|dev|staging|test)', '\\.flaskenv', '\\.environment',
  '\\.(?:bash|zsh|ksh)rc', '\\.(?:bash_|z)?profile', '\\.zshenv', '\\.bash_login', '(?:microsoft\\.(?:powershell|vscode)_)?profile\\.ps1',
].join('|') + ')$');
// auth.json holds the Composer (and other tools') login tokens. One in a translation folder
// (locales/en/auth.json: the text of a login page) is not one.
const AUTH_JSON_RE = /(?:^|\/)auth\.json$/;
const I18N_DIR_RE = /(?:^|\/)(?:locales?|i18n|l10n|lang|langs|languages|translations?|messages|intl)\//;
const authJson = (n) => AUTH_JSON_RE.test(n) && !I18N_DIR_RE.test(n);
// Round 7 (LOW): a Windows device name in the last part (con, aux, com1, lpt1, also with an extension: `aux.js`)
// is not a file: a write there goes to a device (a serial port, a printer), never into the project.
const DEVICE_NAME_RE = /(?:^|[\\/])(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.[^\\/]*)?[. ]*$/i;
export const isDeviceName = (p) => DEVICE_NAME_RE.test(String(p || ''));
// Round 6 (MEDIUM-5): everything inside a .git folder (HEAD, FETCH_HEAD with a token in a remote URL,
// packed-refs, logs, objects). git itself (status, diff, log) reads it through its own rules in allow-list.mjs.
const GIT_DIR_RE = /(?:^|\/)\.git(?:\/|$)/;
const NULL_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', '$null', 'con']);
const WIN = process.platform === 'win32';
// this gateway's own gate code (F5; M5 of rv-autonomy-sec-2): its whole src folder, bin.mjs and
// supervisor.mjs (every module the gate imports lives there, also the ones loaded with a dynamic import),
// and the classifier it loads
const GATE_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_SRC = path.resolve(GATE_DIR, '..');
const GATE_FILES = [path.join(GATE_DIR, '..', 'remote', 'ask-gate.mjs'), path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-actiongate.cjs'),
  path.join(GATEWAY_SRC, '..', 'bin.mjs'), path.join(GATEWAY_SRC, '..', 'supervisor.mjs')];

// words before the program that runs: launch prefixes, shell keywords, the PowerShell call and dot-source operators
const PREFIXES = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'exec', 'command', 'builtin', 'call', 'nice', 'ionice', 'stdbuf', 'xargs', 'watch', 'timeout',
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '&', '.', 'source']);
const PREFIX_VALUE_OPTS = new Set(['-u', '-g', '-n', '-l', '-p', '-s', '-i', '-d', '-e', '-a', '-c']);
const CD_VERBS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'ruby', 'perl', 'php']);
const SCRIPT_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'tsx', 'ts-node']);
const DELETE_VERBS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink', 'shred', 'rimraf', 'del-cli', 'trash',
  'clear-content', 'clc', 'remove-itemproperty', 'rp', 'format', 'diskpart', 'mkfs', 'dd', 'truncate', 'wipe']);
const OUTBOUND_VERBS = new Set(['ssh', 'scp', 'sftp', 'ftp', 'tftp', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'mosh', 'plink', 'pscp', 'psftp', 'winscp',
  'send-mailmessage', 'sendmail', 'mail', 'mailx', 'mutt', 'msmtp', 'swaks']);
const CREDENTIAL_VERBS = new Set(['ssh-keygen', 'ssh-add', 'ssh-copy-id', 'cmdkey', 'security', 'op', 'bw', 'vault', 'keyring', 'get-credential', 'printenv', 'gpg']);
const UNJUDGEABLE_VERBS = new Set(['eval', 'iex', 'invoke-expression']);
const MACHINE_VERBS = new Set(['setx', 'bcdedit', 'netsh', 'set-executionpolicy', 'register-scheduledtask', 'unregister-scheduledtask', 'set-scheduledtask',
  'new-service', 'set-service', 'remove-service', 'install-module', 'install-package', 'install-script', 'update-module', 'uninstall-module',
  'install-psresource', 'update-psresource', 'uninstall-psresource']);
const PUBLISH_VERBS = new Set(['semantic-release', 'release-it', 'np']);
const SYSTEM_INSTALLERS = new Set(['winget', 'choco', 'cinst', 'scoop', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'snap', 'flatpak', 'port', 'gem', 'cargo', 'go', 'pipx']);
const INSTALL_SUBS = new Set(['install', 'uninstall', 'upgrade', 'update', 'remove', 'add', 'i', 'reinstall', 'inject']);
const READ_ONLY = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'ls', 'dir', 'gci', 'get-childitem', 'll', 'tree',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls', 'wc', 'stat', 'file', 'du', 'df', 'test-path', 'resolve-path',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'get-acl', 'measure-object', 'measure', 'select-object', 'select', 'sort-object', 'sort',
  'where-object', 'where', '?', '%', 'foreach-object', 'foreach', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-host',
  'convertfrom-json', 'convertto-json', 'echo', 'write-output', 'write-host', 'printf', 'pwd', 'get-location', 'gl', 'which', 'get-command',
  'gcm', 'realpath', 'readlink', 'basename', 'dirname', 'diff', 'cmp', 'fc', 'comm', 'uniq', 'cut', 'tr', 'jq', 'sha256sum', 'sha1sum',
  'md5sum', 'get-filehash', 'cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'push-location', 'pop-location', 'true', 'false', 'test',
  '[', 'exit', 'sleep', 'start-sleep', 'get-date', 'date', 'whoami', 'hostname', 'get-process', 'ps', 'tasklist', 'netstat', 'ipconfig']);
const GIT_READ_SUBS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'describe', 'cat-file', 'shortlog', 'grep', '']);
// git sub-commands that stay on this computer (or only fetch); the special ones have their own rule in
// gitRule. Any other word (a user alias such as `git pu`, an extension, a typo) is not judged (F4).
const GIT_LOCAL_SUBS = new Set([...GIT_READ_SUBS, 'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'branch', 'bundle', 'check-attr',
  'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clone', 'commit', 'commit-graph',
  'commit-tree', 'count-objects', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc',
  'hash-object', 'help', 'init', 'ls-remote', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mktag', 'mktree',
  'mv', 'name-rev', 'notes', 'pack-refs', 'prune', 'pull', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace',
  'request-pull', 'rerere', 'reset', 'restore', 'rev-list', 'revert', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'submodule',
  'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version',
  'whatchanged', 'worktree', 'write-tree', 'config', 'clean', 'rm', 'credential', 'filter-branch', 'filter-repo']);
// git config keys that run a program, rewrite where git sends data, or carry credentials (F4)
const GIT_RISKY_CONFIG_RE = /^(?:alias\.|include\.|includeif\.|credential\.|filter\.|pager\.|url\.|uploadpack\.|receivepack\.|core\.(?:sshcommand|hookspath|editor|pager|fsmonitor|gitproxy|askpass|attributesfile|excludesfile)|sequence\.editor|diff\.external|http\.(?:proxy|extraheader)|gpg\.)|\.(?:helper|command|sshcommand|textconv|cmd|driver|program|tool|path|proxy|extraheader|uploadpack|receivepack)(?:=|$)/i;
// PowerShell parameters whose value is never a file path, and automatic variables that never hold one
const PS_VALUE_OPTS = new Set(['-value', '-id', '-processid', '-inputobject', '-encoding', '-body', '-uri', '-method', '-headers', '-argumentlist',
  '-filter', '-include', '-exclude', '-pattern', '-newname', '-message', '-seconds', '-milliseconds', '-property', '-delimiter', '-depth', '-timeoutsec',
  // operators: the variable after them is a value
  '-eq', '-ne', '-gt', '-ge', '-lt', '-le', '-like', '-notlike', '-match', '-notmatch', '-contains', '-notcontains', '-in', '-notin',
  '-and', '-or', '-not', '-replace', '-split', '-join', '-f', '-is', '-isnot', '-as']);
const PS_AUTO_VARS = new Set(['_', 'psitem', 'pid', 'true', 'false', 'null', 'lastexitcode', 'matches', 'args', 'input', 'error', 'host']);
const COPY_VERBS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy']);
const MOVE_VERBS = new Set(['mv', 'move', 'move-item', 'mi']);
// web clients whose positional arguments are addresses, and their options that take a local file
const HTTP_VERBS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const HTTP_FILE_OPTS = new Set(['-o', '--output', '-O', '--output-dir', '-T', '--upload-file', '-K', '--config', '-D', '--dump-header', '-c', '--cookie-jar',
  '-b', '--cookie', '-d', '--data', '--data-binary', '-F', '--form', '--post-file', '--body-file', '-OutFile', '-InFile', '-outfile', '-infile', '--download', '-P']);
// PowerShell aliases of cmdlets that take a path: for them `/Users/...` is a path on the current drive
const PS_PATH_ALIASES = new Set(['cp', 'copy', 'cpi', 'mv', 'move', 'mi', 'ni', 'md', 'mkdir', 'sc', 'ac', 'tee', 'ren', 'rni', 'out-file']);
// tool -> sub-commands that stay on this computer; any other sub-command is a production action
const CLOUD_TOOLS = Object.freeze({
  vercel: ['dev', 'build', 'whoami', 'ls', 'list', 'inspect', 'logs'], netlify: ['dev', 'build', 'status', 'logs', 'sites:list', 'functions:serve'],
  firebase: ['emulators:start', 'emulators:exec', 'serve', 'projects:list'], wrangler: ['dev', 'whoami', 'types'],
  supabase: ['start', 'stop', 'status', 'init', 'gen'], heroku: [], aws: [], gcloud: [], gsutil: [], az: [], azd: [], doctl: [], oci: [],
  fly: [], flyctl: [], railway: [], render: [], stripe: [], fastlane: [], ngrok: [], cloudflared: [],
  eas: ['whoami', 'config', 'build:list', 'diagnostics'], tailscale: ['status', 'ip', 'ping', 'netcheck', 'whois'],
  kubectl: ['get', 'describe', 'logs', 'explain', 'api-resources', 'top', 'cluster-info'], oc: ['get', 'describe', 'logs', 'explain'],
  helm: ['list', 'ls', 'status', 'get', 'history', 'show', 'template', 'lint', 'search', 'dependency', 'package', 'create'],
  terraform: ['plan', 'init', 'validate', 'fmt', 'show', 'output', 'providers', 'graph', 'console', 'test'],
  tofu: ['plan', 'init', 'validate', 'fmt', 'show', 'output', 'providers', 'graph', 'console', 'test'],
  pulumi: ['preview', 'whoami', 'about'], cdk: ['synth', 'diff', 'ls', 'list', 'doctor', 'init'], sam: ['build', 'local', 'validate', 'init'],
  serverless: ['print', 'package', 'offline'], sls: ['print', 'package', 'offline'],
});
const VERSION_FLAGS = /^(?:--version|-v|-V|--help|-h|version|help)$/;
// verbs whose `push`/`release`/... sub-command is local or handled by their own rule
const GENERIC_EXEMPT = new Set(['git', 'adb', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'cnpm', 'docker', 'podman', ...READ_ONLY]);

const str = (v) => (typeof v === 'string' ? v : '');
const slashLower = (s) => s.toLowerCase().replace(/\\/g, '/');
const isOpt = (w) => w.startsWith('-');
const isDynamic = (w) => /[$`]|%\w+%/.test(w);
const verdict = (code) => ({ hard: code !== 'routine', code, reason_nl: HARD_GATE_REASONS[code] || HARD_GATE_REASONS.hard_gate });

/** `{ hard, code, reason_nl }` for one permission request. Never throws.
 *  `reachMax`: how many folder entries a search may be checked against before it is "too big to prove".
 *  `codeWritten` (HIGH-2): permissions/store.mjs says the project holds code a routine step wrote that
 *  no owner-approved run has covered; a test runner, build, lint or typecheck then asks ('wrote_code'). A shell
 *  command that writes such a file and runs one is judged that way on its own.
 *  `codeWritten` may also be a function `(family) => boolean` (allow-list.mjs runnerFamily): only a
 *  runner of a dirty family asks. `runners` (a Set, optional) receives the families of every runner the card runs;
 *  for a 'wrote_code' card all of them, so the store can clear exactly those when the owner allows it. */
export function classifyHardGate(toolName, input, { cwd = null, home = os.homedir(), tmp = os.tmpdir(), classify = actionGateClassifier(), reachMax = REACH_MAX, codeWritten = false, runners = null } = {}) {
  try {
    const root = typeof cwd === 'string' && cwd && !isUncPath(cwd) ? path.resolve(cwd) : null;
    const tmpDir = path.resolve(tmp);
    const ctx = {
      cwd: root, home, tmp: tmpDir, classify, vars: new Map(), loops: new Map(),
      reachMax: Number.isInteger(reachMax) && reachMax > 0 ? Math.min(reachMax, REACH_MAX) : REACH_MAX,
      realCwd: root && (realLocation(root) || root), realTmp: isUncPath(tmpDir) ? tmpDir : realLocation(tmpDir) || tmpDir,
    };
    const code = judgeTool(str(toolName), input, ctx); // A: a named hard gate wins (its reason is shown)
    if (code !== 'routine') return verdict(code);
    const selfWrites = SHELL_TOOLS.has(str(toolName)) && shellWrites(str(input.command), toolName === 'PowerShell', ctx, 0).length > 0;
    ctx.codeWritten = selfWrites || codeWritten === true ? true : typeof codeWritten === 'function' ? codeWritten : false;
    const seen = new Set();
    const collect = runners instanceof Set ? (f) => { seen.add(f); runners.add(f); } : (f) => seen.add(f);
    const refused = []; // package scripts the allow-list refused: the owner sees what they really do (M7)
    const noted = []; // why the allow-list refused a read (a sensitive file, a place outside the project)
    if (allowListed(str(toolName), input, allowContext(ctx, (line, base) => refused.push({ line, base }), (c) => noted.push(c), collect))) return verdict('routine'); // B
    for (const { line, base } of refused.slice(0, 6)) {
      const c = judgeShell(line, false, { ...ctx, cwd: base, vars: new Map(), loops: new Map() });
      if (c !== 'routine') return verdict(c);
    }
    const final = noted[0] || 'not_allowlisted';
    // the reading stopped at the first dirty runner: read once more as if nothing were written, to name every family it runs
    if ((final === 'wrote_code' || final === 'first_runner') && runners instanceof Set) allowListed(str(toolName), input, allowContext({ ...ctx, codeWritten: false }, () => {}, () => {}, collect));
    return verdict(final);
  } catch {
    return verdict('unjudgeable');
  }
}

/** What allow-list.mjs may ask of this file: where a path points, and whether it is the project's or protected. */
function allowContext(ctx, refusedScript, note, runnerSeen = null) {
  return {
    refusedScript,
    note,
    runnerSeen, // the family of each runner the allow-list passes
    tmp: ctx.tmp,
    // a read target judged at its real location: null when provably fine, else the reason code
    readProblem: (abs, kind, tail) => readProblem(abs, kind, ctx, tail),
    secretText: (s) => credentialPath(s), // the names that are safe to look for in any text (a search pattern)
    root: ctx.cwd,
    locate: (p, base) => locate(p, base, ctx),
    realOf: (abs) => (abs && !isUncPath(abs) ? realLocation(abs) : null), // null: it cannot be resolved
    // the path from the project's real location to where `abs` really lands (links followed), or null when outside
    projectRel: (abs) => {
      if (!abs || isUncPath(abs) || !ctx.realCwd) return null;
      const real = realOf(abs);
      return inside(ctx.realCwd, real) ? path.relative(ctx.realCwd, real) : null;
    },
    // the write side refuses every sensitive name the read side does (prod.env, *.key as well);
    // and a Windows device name (`src/aux.js`, `COM1`), which is no file in the project
    protectedPath: (abs) => isDeviceName(abs) || gateKindAt(abs, ctx) !== null || sensitivePath(abs) || sensitivePath(realOf(abs)),
    credential: (s) => sensitivePath(s), // reads/args of a credential OR secret-bearing config file wait
    // round 6 (HIGH-2): the project holds code a routine step wrote that no owner-approved run covered yet;
    // true, false, or a function of the runner family
    codeWritten: typeof ctx.codeWritten === 'function' ? ctx.codeWritten : ctx.codeWritten === true,
    // an append-only redirect into one of Forge's end-of-run memory files (writeTarget, MEMORY_LOG_RE)
    memoryLog: (abs) => memoryLog(abs, ctx),
  };
}

export function isHardGatePermission(toolName, input, options) {
  return classifyHardGate(toolName, input, options).hard;
}

function judgeTool(name, input, ctx) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'unjudgeable';
  if (SHELL_TOOLS.has(name)) {
    const f = judgeFields(input, ctx, SHELL_KNOWN); // a cwd or a sandbox switch next to the command
    return f !== 'routine' ? f : judgeShell(input.command, name === 'PowerShell', ctx);
  }
  if (EDIT_TOOLS.has(name)) return judgeEdit(input, ctx);
  if (READ_TOOLS.has(name)) {
    const spots = [str(input.file_path), str(input.path), str(input.notebook_path), name === 'Glob' ? str(input.pattern) : '', name === 'Grep' ? str(input.glob) : ''].filter(Boolean);
    if (spots.some(isRemoteUnc)) return 'outbound'; // F6: reading a share sends the Windows credential to that host
    return spots.some(sensitiveReadTarget) ? 'credentials' : 'routine';
  }
  // M1 (round-3): a WebFetch to any non-loopback host is a card — an attacker can carry data out in the
  // URL (path or query). Only a loopback host (a local dev server / the gateway) stays routine.
  if (name === 'WebFetch') {
    let u;
    try { u = new URL(str(input.url)); } catch { return 'unjudgeable'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'unjudgeable';
    return isLoopbackHost(u.hostname) ? 'routine' : 'outbound';
  }
  if (name === 'Agent' || name === 'Task') return judgeFields(input, ctx, DISPATCH_KNOWN); // round 8 (F1)
  if (name === 'WebSearch') return webSearchProblem(input) || 'routine'; // round 8 (LOW): a query that may carry data
  return ROUTINE_TOOLS.has(name) ? 'routine' : 'unknown_tool';
}

// the fields of an Agent or Task call that are known and checked by allow-list.mjs (dispatchAllowed), and
// the fields Claude Code sends with a shell command (dangerouslyDisableSandbox is judged below: on is 'settings').
const DISPATCH_KNOWN = new Set(['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'run_in_background', 'isolation', 'cwd']);
const SHELL_KNOWN = new Set(['command', 'description', 'timeout', 'run_in_background']);
// a field that changes with what permissions the subagent or command runs, or where
const DISPATCH_PERMISSION_KEY_RE = /mode|permission|sandbox|allowed|disallowed|^tools$|settings|^env$|dangerous|bypass|hook|mcp/i;
const DISPATCH_PATH_KEY_RE = /cwd|dir|path|root|folder|workspace|worktree|location|repo/i;

/**
 * The extra fields of an Agent, Task or shell call: the named reason of what makes it wait, or 'routine' (allow-list.mjs
 * still has to prove every field). A `cwd` (or any path-like field) whose real location is not inside the run folder:
 * 'outside_folder'; a share on another computer or an Agent's `isolation: 'remote'`: 'outbound'; a `mode`, a tool list,
 * settings, env or a sandbox switch that is on: 'settings'.
 */
function judgeFields(input, ctx, known) {
  for (const [key, value] of ownFields(input)) {
    if (key === null) continue; // round 9 (a1): a hidden or symbol key; the allow-list refuses it
    if (known.has(key) && key !== 'cwd') {
      if (key === 'isolation' && value === 'remote') return 'outbound';
      continue;
    }
    if (key === 'cwd' || (DISPATCH_PATH_KEY_RE.test(key) && !DISPATCH_PERMISSION_KEY_RE.test(key))) {
      if (typeof value !== 'string' || value === '') continue; // the allow-list refuses it
      if (isRemoteUnc(value)) return 'outbound';
      if (driveRelative(value)) return 'unjudgeable'; // round 9 (a1): `C:foo` depends on the per-drive current folder
      const real = dispatchReal(value, ctx.cwd, ctx);
      if (!real || !inside(ctx.realCwd, real)) return 'outside_folder';
      continue;
    }
    if (DISPATCH_PERMISSION_KEY_RE.test(key) && value !== false) return 'settings';
  }
  return 'routine';
}

/** The real location of a subagent folder `v` read from `base`, or null when it cannot be known. */
function dispatchReal(v, base, ctx) {
  const abs = locate(v, base, ctx);
  return abs && !isUncPath(abs) ? realLocation(abs) : null;
}

/**
 * where the subagent an Agent or Task call starts works. `cwd` is the folder of the agent that calls it
 * (a relative `cwd` field is read from there), `root` the run folder. Returns `{ folder, outside }`: `folder` the real
 * folder its relative paths resolve against (its `cwd` field, else `cwd`); `outside` true when that field is not a
 * folder inside `root` at its real location (a junction, an 8.3 short name and letter case resolved), or cannot be
 * judged. permissions/store.mjs judges the subagent's own cards there, and every card of an outside one waits. Never throws.
 * `folder` is the real location only when that folder exists now, else the path as named (resolved); a
 * drive-relative `cwd` (`C:foo`) is outside. The store checks the real location again at every card of the subagent
 * (folderStillInside below).
 */
export function dispatchFolder(input, { cwd = null, root = cwd, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  try {
    const base = typeof cwd === 'string' && cwd && !isUncPath(cwd) ? path.resolve(cwd) : null;
    const top = typeof root === 'string' && root && !isUncPath(root) ? path.resolve(root) : null;
    const v = input && typeof input === 'object' && !Array.isArray(input) ? input.cwd : undefined;
    if (v === undefined) return { folder: base, outside: false };
    if (typeof v !== 'string' || v === '' || !base || !top || isUncPath(v) || driveRelative(v)) return { folder: null, outside: true };
    const hctx = { home, tmp: path.resolve(tmp) };
    const real = dispatchReal(v, base, hctx);
    const realTop = realLocation(top) || top;
    if (!real || !inside(realTop, real)) return { folder: real, outside: true };
    // a folder that does not exist yet is kept by its name; the store checks it again at every card
    const abs = locate(v, base, hctx);
    let exists = false;
    try { exists = fs.statSync(real).isDirectory(); } catch { exists = false; }
    return { folder: exists ? real : abs || real, outside: false };
  } catch {
    return { folder: null, outside: true };
  }
}

/** true when `folder` is, at its real location right now, inside the run folder `root`. Never throws. */
export function folderStillInside(folder, root) {
  try {
    if (typeof folder !== 'string' || !folder || typeof root !== 'string' || !root || isUncPath(folder) || isUncPath(root)) return false;
    const realTop = realLocation(path.resolve(root));
    const real = realLocation(path.resolve(folder));
    return Boolean(realTop && real && inside(realTop, real));
  } catch {
    return false;
  }
}

function judgeEdit(input, ctx) {
  const p = str(input.file_path) || str(input.notebook_path);
  if (!p || !ctx.cwd) return 'unjudgeable';
  if (isRemoteUnc(p)) return 'outbound';
  const abs = locate(p, ctx.cwd, ctx);
  if (!abs || isDeviceName(p)) return 'outside_folder'; // `src/aux.js` is a device on Windows, not a file
  // the real location (a link is followed) and, on Windows, the NTFS alias form (`x::$DATA`, `x.`) all
  // name the same file: a gate or credential file reached through any of them is still that file.
  for (const a of WIN ? [abs, winName(abs), realOf(abs), winName(realOf(abs))] : [abs, realOf(abs)]) {
    const g = gateKind(a, ctx);
    if (g) return g;
    if (sensitivePath(a)) return 'credentials'; // prod.env and *.key too, not only the credentialPath names
  }
  return writable(ctx, abs) ? 'routine' : 'outside_folder';
}

function credentialPath(s) {
  const n = slashLower(s);
  return CREDENTIAL_RE.test(n) || CREDENTIAL_DIR_RE.test(n) || BROWSER_STORE_RE.test(n);
}

/** The name Windows really opens: a stream suffix (`x::$DATA`, `x:stream`) and trailing dots or spaces
 *  on a path part are dropped, so `.env::$DATA` and `.claude/settings.json.` resolve to the real file. */
function winName(p) {
  const m = /^([A-Za-z]:)?([\s\S]*)$/.exec(p);
  return (m[1] || '') + m[2].split(/([\\/])/).map((c) => (c === '.' || c === '..' ? c : c.replace(/:.*$/, '').replace(/[. ]+$/, ''))).join('');
}

/** A file whose CONTENTS are sensitive (credential, private key or secret-bearing config): the ONE
 *  read-side source. Only ever called with a single path value, so PRIVATE_KEY_RE is safe here. */
function sensitivePath(s) {
  return sensitiveName(s) || GIT_DIR_RE.test(slashLower(s));
}

/** sensitivePath without the .git rule: a file sensitive by its own name. */
function sensitiveName(s) {
  const n = slashLower(s);
  return credentialPath(s) || PRIVATE_KEY_RE.test(n) || ENV_FILE_RE.test(n) || CONFIG_READ_RE.test(n) || CRED_NAME_RE.test(n) || authJson(n);
}

/** sensitivePath for one path value, also through its Windows NTFS-alias name. */
function sensitiveReadTarget(p) {
  return sensitivePath(p) || (WIN && sensitivePath(winName(p)));
}

function credentialText(text) {
  if (credentialPath(text) || SECRET_VAR_RE.test(text) || /x-cc-exec-token/i.test(text) || redact(text) !== text) return 'credentials';
  return null;
}

// ---------------------------------------------------------------- network shares (F6)

/** True for `\\x` and `//x` (and the `\\?\` / `\\.\` device forms): never touched on disk here. */
function isUncPath(s) {
  return /^[\\/]{2}/.test(s);
}

/** True when `s` names a share on another computer: `\\host\share`, `//host/share`, `\\?\UNC\host\share`. */
function isRemoteUnc(s) {
  const n = String(s).replace(/\\/g, '/');
  let m = /^\/\/[?.]\/unc\/([^/]+)\/[^/]/i.exec(n);
  if (!m) {
    if (/^\/\/[?.]\//.test(n)) return false; // a local device path (\\?\C:\..., \\.\pipe\...)
    m = /^\/\/([^/]+)\/[^/]/.exec(n); // `//c` alone (Git Bash `cmd //c`) has no share part
  }
  return Boolean(m) && !/^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(m[1]);
}

// ---------------------------------------------------------------- reads (escalation round: F1-F3)

const REACH_MAX = 20_000; // folder entries one search may be checked against; a bigger tree is not proven
const REACH_SECRETS = 200;
// Round 5: how long a big walk is trusted. A sensitive file created below the folder within this window
// is not seen yet; 2 s still covers a burst of cards from one turn (was 10 s).
const REACH_TTL_MS = 2_000;
const REACH_CACHE_FROM = 2_000; // only a big walk is remembered: a small one is always fresh
const reachCache = new Map(); // real folder + roots + mode -> { at, result }

/** What a read of every file below folder `dir` (a real location) can reach: `{ secrets, code }`.
 *  secrets: the sensitive files and folders below it (lower case, forward slashes; a folder ends in /).
 *  code: null, or why the tree cannot be proven: a link that leaves the project ('outside_folder'), a
 *  folder that cannot be listed or a tree bigger than ctx.reachMax ('not_allowlisted').
 *  `tail` '': stop at the first sensitive file (enough when no glob narrows what is read); else only files
 *  whose path ends with it can be read, so only those (and sensitive folders) are recorded.
 *  `repo`: what git can print of a working tree, so its own .git folders are not part of it.
 *  Round 6: every file inside a .git folder is sensitive. A read narrowed by a tail (`**` + `/*.mjs`) looks
 *  inside .git file by file (as before this round); a read nothing narrows stops at the folder itself. */
function reach(dir, ctx, tail, repo) {
  const all = tail !== '';
  const key = [slashLower(dir), ctx.realCwd, ctx.realTmp, ctx.reachMax, tail, repo ? 'repo' : 'files'].join('\0');
  const hit = reachCache.get(key);
  if (hit && Date.now() - hit.at < REACH_TTL_MS) return hit.result;
  const result = { secrets: [], code: null };
  const queue = [dir];
  const seen = new Set([slashLower(dir)]);
  let count = 0;
  walk: for (let i = 0; i < queue.length; i++) {
    let entries;
    try { entries = fs.readdirSync(queue[i], { withFileTypes: true }); } catch { result.code = 'not_allowlisted'; break; }
    for (const e of entries) {
      if (repo && e.name.toLowerCase() === '.git') continue;
      count += 1;
      if (count > ctx.reachMax) { result.code = 'not_allowlisted'; break walk; }
      let p = path.join(queue[i], e.name);
      let isDir = e.isDirectory();
      let secret = sensitiveName(p);
      let inGit = GIT_DIR_RE.test(slashLower(p));
      if (e.isSymbolicLink()) { // a link or a junction: judged where it really points
        const real = realLocation(p);
        if (!real || isUncPath(real)) { result.code = 'not_allowlisted'; break walk; }
        if (!inside(ctx.realCwd, real) && !inside(ctx.realTmp, real)) { result.code = 'outside_folder'; break walk; }
        secret = secret || sensitiveName(real);
        inGit = inGit || GIT_DIR_RE.test(slashLower(real));
        p = real;
        try { isDir = fs.statSync(real).isDirectory(); } catch { isDir = false; }
      }
      if (!secret && inGit && !(all && isDir)) secret = true;
      if (secret && all && !isDir && !slashLower(p).endsWith(tail)) continue; // this read cannot match that file
      if (secret) {
        if (result.secrets.length >= REACH_SECRETS) { result.code = 'not_allowlisted'; break walk; }
        result.secrets.push(slashLower(p) + (isDir ? '/' : ''));
        if (!all) break walk;
        continue; // everything below a sensitive folder is sensitive
      }
      if (isDir && !seen.has(slashLower(p))) { seen.add(slashLower(p)); queue.push(p); }
    }
  }
  if (count >= REACH_CACHE_FROM) {
    reachCache.set(key, { at: Date.now(), result });
    if (reachCache.size > 32) reachCache.delete(reachCache.keys().next().value);
  }
  return result;
}

/** One read target, judged where it really is: null when it is provably fine, else the reason code.
 *  kind 'where': only that it is inside (a name a lister's wildcard shows). kind 'list': names and sizes
 *  only, of a named file or folder. kind 'content': the text of the file, or of every file below the
 *  folder. kind 'repo': the same for what git prints of a working tree (never its .git folder). `tail`: only files whose path ends with it can be read (the literal end of a glob filter).
 *  A target that cannot be resolved (a broken link, a name Windows cannot open) is never proven. */
function readProblem(abs, kind, ctx, tail = '') {
  if (!abs || isUncPath(abs)) return 'not_allowlisted';
  const real = realLocation(abs);
  if (!real || isUncPath(real)) return 'not_allowlisted';
  if (kind !== 'where' && [abs, real].some((p) => sensitivePath(p) || (WIN && sensitivePath(winName(p))))) return 'credentials';
  if (!inside(ctx.realCwd, real) && !inside(ctx.realTmp, real)) return 'outside_folder';
  if (kind !== 'content' && kind !== 'repo') return null;
  let isDir = false;
  try { isDir = fs.statSync(real).isDirectory(); } catch { return null; } // nothing there to read
  if (!isDir) return null;
  const end = slashLower(String(tail || ''));
  const r = reach(real, ctx, end, kind === 'repo');
  if (r.secrets.some((s) => s.endsWith('/') || s.endsWith(end))) return 'credentials';
  return r.code;
}

// ---------------------------------------------------------------- gate code (F5)

const PROTECT_TTL_MS = 30_000;
const CLOSURE_MAX = 400;
const protectCache = new Map(); // cwd + home -> { at, files: Set<slashLower absolute path> }
const HELPER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

/** Every command a settings file makes Claude Code run: hooks, the status line and the helpers. */
function settingsCommands(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (!s || typeof s !== 'object') return [];
  const out = HELPER_KEYS.map((k) => s[k]).filter((v) => typeof v === 'string');
  if (s.statusLine && typeof s.statusLine.command === 'string') out.push(s.statusLine.command);
  for (const list of Object.values(s.hooks && typeof s.hooks === 'object' ? s.hooks : {})) {
    for (const m of Array.isArray(list) ? list : []) {
      for (const h of m && Array.isArray(m.hooks) ? m.hooks : []) if (h && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

/** The script files one command line runs (`node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/x.cjs"`). */
function scriptsIn(command, ctx) {
  let words;
  try { words = lexCommand(command.slice(0, MAX_COMMAND_CHARS), false).segments.flatMap((s) => s.words); } catch { return []; }
  return words.filter((w) => /\.(?:c?js|mjs|ts|ps1|sh|py|bat|cmd)$/i.test(w))
    .map((w) => locate(w.replace(/^(?:\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%)/, ctx.cwd), ctx.cwd, ctx))
    .filter((p) => p && !isUncPath(p));
}

/** The file a relative require/import names; the written path itself when none exists (creating it would add code). */
function resolveModule(p) {
  for (const c of [p, p + '.cjs', p + '.js', p + '.mjs', p + '.json', path.join(p, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return path.extname(p) ? p : null;
}

const MCP_CONFIG_MAX = 5_000_000;
const readJson = (file) => {
  try { return fs.statSync(file).size > MCP_CONFIG_MAX ? null : JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const serversOf = (o, key) => (o && o[key] && typeof o[key] === 'object' && !Array.isArray(o[key]) ? Object.values(o[key]) : []);

/** the MCP servers a program starts by itself: `{ claude, editor }`. Claude Code reads the project's
 *  .mcp.json and ~/.claude.json (the user scope and this project's local scope); VS Code and Cursor read
 *  .vscode/mcp.json and .cursor/mcp.json. */
function mcpServers(ctx) {
  const claude = [...serversOf(readJson(path.join(ctx.cwd, '.mcp.json')), 'mcpServers')];
  const user = readJson(path.join(ctx.home, '.claude.json'));
  claude.push(...serversOf(user, 'mcpServers'));
  const here = new Set([ctx.cwd, ctx.realCwd].filter(Boolean).map((p) => slashLower(path.resolve(p))));
  for (const [dir, entry] of Object.entries(user && typeof user.projects === 'object' && user.projects ? user.projects : {})) {
    if (here.has(slashLower(path.resolve(dir)))) claude.push(...serversOf(entry, 'mcpServers'));
  }
  const vscode = readJson(path.join(ctx.cwd, '.vscode', 'mcp.json'));
  const editor = [...serversOf(vscode, 'servers'), ...serversOf(vscode, 'mcpServers'), ...serversOf(readJson(path.join(ctx.cwd, '.cursor', 'mcp.json')), 'mcpServers')];
  return { claude, editor };
}

/** The files one MCP server entry starts: every word of its command and args that names an existing file, or a
 *  script by its extension, from the project folder, its `cwd` or a `--directory`/`--cwd` it is given. */
function mcpServerFiles(server, ctx) {
  if (!server || typeof server !== 'object') return [];
  const words = [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter((w) => typeof w === 'string' && w.length < 1000);
  const root = (w) => w.replace(/^(?:\$\{(?:workspaceFolder|workspaceRoot|CLAUDE_PROJECT_DIR)\}|\$CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%)(?=$|[\\/])/, ctx.cwd);
  const bases = [ctx.cwd];
  if (typeof server.cwd === 'string') bases.push(locate(root(server.cwd), ctx.cwd, ctx));
  for (let k = 0; k + 1 < words.length; k++) if (/^--?(?:directory|cwd|dir|project|prefix|C)$/.test(words[k])) bases.push(locate(root(words[k + 1]), ctx.cwd, ctx));
  const out = [];
  for (const w of words) {
    if (w.startsWith('-') || /^[a-z][\w+.-]*:\/\//i.test(w)) continue;
    for (const b of bases) {
      const abs = b && locate(root(w), b, ctx);
      if (!abs || isUncPath(abs)) continue;
      let isFile = false;
      try { isFile = fs.statSync(abs).isFile(); } catch { /* not there (yet) */ }
      if (isFile || /\.(?:c?js|mjs|ts|py|sh|ps1|bat|cmd)$/i.test(w)) out.push(abs);
    }
  }
  return out;
}

/** The hook scripts of the project and user settings and every module they require (cached 30 s), and
 *  the scripts the MCP configs start. `{ files, editor }`: editor = what only VS Code or Cursor starts. */
function protectedSets(ctx) {
  if (!ctx.cwd) return { files: new Set(), editor: new Set() };
  const key = ctx.cwd + '\0' + ctx.home;
  const hit = protectCache.get(key);
  if (hit && Date.now() - hit.at < PROTECT_TTL_MS) return hit.sets;
  const queue = [GATE_FILES[1]];
  for (const dir of [path.join(ctx.cwd, '.claude'), path.join(ctx.home, '.claude')]) {
    for (const name of ['settings.json', 'settings.local.json']) {
      for (const cmd of settingsCommands(path.join(dir, name))) queue.push(...scriptsIn(cmd, ctx));
    }
  }
  const servers = mcpServers(ctx);
  for (const s of servers.claude) queue.push(...mcpServerFiles(s, ctx));
  const sets = { files: requireClosure(queue), editor: requireClosure(servers.editor.flatMap((s) => mcpServerFiles(s, ctx))) };
  protectCache.set(key, { at: Date.now(), sets });
  if (protectCache.size > 32) protectCache.delete(protectCache.keys().next().value);
  return sets;
}

/** The files and every module they require (relative require/import), at most CLOSURE_MAX. */
function requireClosure(queue) {
  const files = new Set();
  while (queue.length && files.size < CLOSURE_MAX) {
    const f = queue.shift();
    const k = slashLower(f);
    if (files.has(k)) continue;
    files.add(k);
    if (!/\.(?:c?js|mjs)$/i.test(f)) continue;
    let src;
    try { src = fs.readFileSync(f, 'utf8').slice(0, 2_000_000); } catch { continue; }
    for (const m of src.matchAll(/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)['"](\.\.?\/[^'"]+)['"]|__dirname\s*,\s*['"]([^'"]+)['"]/g)) {
      const r = resolveModule(path.resolve(path.dirname(f), m[1] || m[2]));
      if (r) queue.push(r);
    }
  }
  return files;
}

/** What a write to `p` changes, or null: 'settings' when it changes what Claude Code, the gate hook or this
 *  gateway's gate runs or is told; 'auto_run' when it is a file inside the project that makes code
 *  run later by itself or instructs another agent or an editor (AUTO_RUN_RE). */
function gateKind(p, ctx) {
  if (!p) return null;
  const n = slashLower(p);
  if (GIT_HOOK_RE.test(n) && path.isAbsolute(p) && (inside(ctx.cwd, p) || inside(ctx.realCwd, p))) return 'auto_run'; // round 8
  if (SETTINGS_RE.test(n) || GATE_WRITE_RE.test(n) || FORGE_GATE_RE.test(n)) return 'settings';
  if (!path.isAbsolute(p)) return null;
  const here = inside(ctx.cwd, p) || inside(ctx.realCwd, p);
  if (CLAUDE_MD_RE.test(n) && here) return 'settings';
  if (inside(GATEWAY_SRC, p) || GATE_FILES.some((f) => path.relative(f, p) === '')) return 'settings';
  // an MCP server may be started with any file (also one without an extension), so every write
  // target is looked up in the closure; it is cached for 30 s per project folder
  const sets = protectedSets(ctx);
  const k = slashLower(path.resolve(p));
  if (sets.files.has(k)) return 'settings';
  if (sets.editor.has(k)) return 'auto_run'; // VS Code or Cursor starts it
  return here && AUTO_RUN_RE.test(n) ? 'auto_run' : null;
}

/** gateKind of a path and of where it really lands (a link inside the project is followed). */
const gateKindAt = (abs, ctx) => gateKind(abs, ctx) || gateKind(realOf(abs), ctx);

function judgeShell(command, isPs, ctx) {
  if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND_CHARS) return 'unjudgeable';
  if (typeof ctx.classify !== 'function') return 'classifier_unavailable';
  if (!ctx.cwd) return 'unjudgeable';
  const own = credentialText(command) || judgeText(command, isPs, ctx, 0);
  if (own) return own;
  const r = ctx.classify(command);
  if (r && r.gate === true) return ACTION_GATE_CODES[r.id] || 'hard_gate';
  return 'routine';
}

// PowerShell .NET method calls that only read or build values; any other method call (Delete,
// WriteAllText, Kill, UploadFile, Start, ...) is not judged and makes the card a hard gate.
const PS_READ_METHODS = new Set(['tostring', 'trim', 'trimstart', 'trimend', 'split', 'replace', 'contains', 'startswith', 'endswith',
  'substring', 'indexof', 'lastindexof', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant', 'gettype', 'equals', 'compareto',
  'padleft', 'padright', 'join', 'format', 'parse', 'tryparse', 'combine', 'getfilename', 'getfilenamewithoutextension', 'getdirectoryname',
  'getextension', 'getfullpath', 'exists', 'readalltext', 'readalllines', 'add', 'where', 'foreach', 'containskey', 'match', 'matches',
  'ismatch', 'round', 'max', 'min', 'abs', 'floor', 'ceiling', 'now', 'today', 'adddays', 'addhours', 'addminutes', 'addseconds']);

/** 'unjudgeable' when PowerShell code calls a method outside the read-only list (string contents are skipped). */
function psMethodProblem(text) {
  const code = text.replace(/'[^']*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, (s) => (s.match(/\$\([^()]*\)/g) || []).join(' '));
  for (const m of code.matchAll(/(?:[\])'\w])\s*(?:\.|::)\s*([A-Za-z_]\w*)\s*\(/g)) if (!PS_READ_METHODS.has(m[1].toLowerCase())) return 'unjudgeable';
  return null;
}

/** NAME=value words (sh) or `$NAME = value` (PowerShell) with a literal value: the variables a later segment may use. */
function assignments(words, isPs) {
  if (isPs) return words.length === 3 && /^\$\w+$/.test(words[0]) && words[1] === '=' && !isDynamic(words[2]) ? [[words[0].slice(1), words[2]]] : null;
  if (!words.length || !words.every((w) => /^[A-Za-z_]\w*=/.test(w))) return null;
  return words.map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]).filter(([, v]) => !isDynamic(v));
}

function expandVars(word, vars) {
  return vars.size ? word.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => (vars.has(a || b) ? vars.get(a || b) : m)) : word;
}

function judgeText(text, isPs, ctx, depth) {
  if (depth > MAX_DEPTH) return 'unjudgeable';
  if (isPs) { const p = psMethodProblem(text); if (p) return p; }
  let lexed;
  try { lexed = lexCommand(text, isPs); } catch { return 'unjudgeable'; }
  let base = ctx.cwd;
  const stack = [];
  const vars = new Map(ctx.vars);
  let loops = new Map(ctx.loops);
  const loopsAt = []; // the loop variables each segment sees (a substitution sees those of its own segment)
  for (const seg of lexed.segments) {
    const words = seg.words.map((w) => expandVars(w, vars));
    if (!isPs && words[0] === 'for' && /^[A-Za-z_]\w*$/.test(words[1] || '') && words[2] === 'in') {
      // `for f in a b`: runs nothing itself; a literal list lets a later "$f" path be judged item by item
      const items = loopItems(words.slice(3), loops, { ...ctx, base });
      loops = new Map(loops);
      if (items) loops.set(words[1], items); else loops.delete(words[1]);
      loopsAt.push(loops);
      continue;
    }
    const assigns = ['do', 'then', 'else'].includes(words[0]) ? words.slice(1) : words;
    if (!isPs && assigns.length && assigns.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
      // `f=dir/$t.test.cjs` inside a loop over t: f takes one value per item
      for (const w of assigns) {
        const name = w.slice(0, w.indexOf('=')); const value = w.slice(w.indexOf('=') + 1);
        const listed = /^\$\([\s\S]*\)$/.test(value) ? listerItems(value.slice(2, -1), { ...ctx, base }) : null;
        if (listed) { loops = new Map(loops); loops.set(name, listed); continue; } // L=$(grep -l x src/*.js)
        const refs = [...new Set([...value.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].map((m) => m[1]))];
        if (refs.length !== 1 || !loops.has(refs[0]) || /\$\(|`/.test(value)) continue;
        loops = new Map(loops);
        loops.set(name, loops.get(refs[0]).map((item) => value.replace(/\$\{?([A-Za-z_]\w*)\}?/g, item)));
      }
    }
    loopsAt.push(loops);
    const here = { ...ctx, base, isPs, depth, vars, loops, heredoc: seg.heredoc };
    for (const [k, t] of seg.redirects.entries()) { const c = writeTarget(expandVars(t, vars), here, seg.appends && seg.appends[k] === true); if (c) return c; }
    const set = assignments(words, isPs);
    if (set && !isPs) { for (const [k, v] of set) vars.set(k, v); continue; } // only sets variables
    if (set) for (const [k, v] of set) vars.set(k, v);
    const c = judgeCommand(words, here);
    if (c) return c;
    base = nextBase(words, base, stack, ctx);
  }
  // substitutions run too; they see the variables this command line sets
  for (const [j, sub] of lexed.subs.entries()) {
    const c = judgeText(sub, isPs, { ...ctx, vars, loops: loopsAt[lexed.subSegs[j]] || loops }, depth + 1);
    if (c) return c;
  }
  return null;
}

// commands that only list or filter names: their output is made of the paths they were given
const LISTERS = new Set(['ls', 'dir', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'git', 'head', 'tail', 'sort', 'uniq', 'sed', 'cut', 'tr', 'basename', 'dirname']);

/** What `for x in <words>` iterates over: literal words, the list of a loop variable (`$L`), or the
 *  project paths a listing substitution (`$(grep -l x src/*.js)`) names; null when unknown. */
function loopItems(items, loops, ctx) {
  if (!items.length) return null;
  if (!items.some(isDynamic)) return items;
  if (items.length !== 1) return null;
  const v = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(items[0]);
  if (v) return loops.get(v[1]) || null;
  return /^\$\([\s\S]*\)$/.test(items[0]) ? listerItems(items[0].slice(2, -1), ctx) : null;
}

/** The path arguments of a listing pipeline (ls, grep -l, git diff --name-only, find without -exec, then
 *  filters), when every one of them is a literal inside the project or temp: what its output can name.
 *  shortcut: `git diff --name-only` names paths relative to the repository root; for a project that is a
 *  sub-folder of a bigger repository they can name a sibling folder. */
function listerItems(text, ctx) {
  let lx;
  try { lx = lexCommand(text, false); } catch { return null; }
  const paths = [];
  for (const seg of lx.segments) {
    const w = seg.words;
    const verb = verbName(w[0] || '');
    if (!LISTERS.has(verb) || !readOnly(verb, w.slice(1)) || seg.redirects.length) return null;
    for (const a of w.slice(1)) if (!isOpt(a) && /[\\/*]|\.\w{1,8}$/.test(a)) paths.push(a);
  }
  if (lx.subs.length) return null;
  const list = paths.length ? paths : ['.'];
  for (const p of list) { if (isDynamic(p) || !writable(ctx, locate(p, ctx.base, ctx))) return null; }
  return list;
}

function findVerb(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; } // NAME=value before a command
    const lw = verbName(w);
    if (!PREFIXES.has(lw) || i === words.length - 1) break; // a prefix on its own (env, set) is the command
    i += 1;
    while (i < words.length - 1 && isOpt(words[i])) { if (PREFIX_VALUE_OPTS.has(words[i].toLowerCase())) i += 1; i += 1; }
    if (lw === 'timeout' && /^\d/.test(words[i] || '')) i += 1;
  }
  return i < words.length ? i : -1;
}

function verbName(w) {
  return path.basename(w.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

const firstArg = (rest) => { const k = rest.findIndex((w) => !isOpt(w)); return k < 0 ? { sub: '', at: -1 } : { sub: rest[k].toLowerCase(), at: k }; };

function judgeCommand(words, ctx) {
  const vi = findVerb(words);
  if (vi < 0) return null;
  const raw = words[vi];
  if (ctx.isPs && (raw.startsWith('$') || raw.startsWith(PS_STRING)) && words[vi - 1] !== '&') { // a PowerShell expression statement runs no program, except the right side of an assignment
    return /^[+\-*/?]?\??=$/.test(words[vi + 1] || '') ? judgeCommand(words.slice(vi + 2), ctx) : null;
  }
  const rest = words.slice(vi + 1);
  // F6: a word naming a share on another computer makes Windows send the user's credential there
  if ([raw, ...rest].some((w) => optionParts(w).some(isRemoteUnc))) return 'outbound';
  if (isDynamic(raw)) return 'unjudgeable';
  if (SETTINGS_RE.test(slashLower(raw))) return 'settings';
  const verb = verbName(raw);
  // F4: bash runs `git p\ush` as `git push` and `git {push,}` as `git push`; such a program or
  // sub-command word is not judged
  if (!ctx.isPs && !readOnly(verb, rest) && [raw, ...rest.filter((w) => !isOpt(w)).slice(0, 2)].some(shellTrick)) return 'unjudgeable';
  const inner = innerOf(verb, rest, ctx.heredoc, ctx.isPs);
  if (inner) { // the launched command is what runs; the launcher's own arguments are its text
    if (inner.code) return inner.code;
    if (inner.alts) { for (const alt of inner.alts) { const c = judgeCommand(alt, ctx); if (c) return c; } return null; }
    if (inner.inline !== undefined) {
      // code that writes may write the files its arguments name (`node -e "...writeFileSync(process.argv[1]..." "$f"`)
      return judgeInline(inner.inline, ctx) || (inner.args && inner.args.length && INLINE_WRITE_RE.test(inner.inline) ? pathRule('', inner.args, ctx) : null);
    }
    return inner.text !== undefined ? judgeText(inner.text, inner.isPs ?? ctx.isPs, ctx, ctx.depth + 1) : judgeCommand(inner.words, ctx);
  }
  return programRule(verb, raw, rest, ctx) || pathRule(verb, rest, ctx);
}

/** An escaped letter (`p\ush`) or a brace expansion (`{push,}`) that bash turns into another word. */
function shellTrick(w) {
  // no dot: a quoted Windows path such as "tools\x.cjs" is a file, not a word bash rewrites; a brace
  // expansion is a bare word (inline code or JSON has quotes, spaces or brackets around its braces)
  return (w.includes('\\') && /^[\w\\-]+$/.test(w)) || /^[\w.@:+-]*\{[\w.@:+-]*(?:,|\.\.)[\w.@:,+-]*\}[\w.@:+-]*$/.test(w);
}

/** The words a launcher could run: `rest` after its `/x` switches (cmd's `start`, the `/d` switch takes a folder). */
function skipSlashSwitches(rest, k) {
  while (k < rest.length && /^\//.test(rest[k])) { if (/^\/d$/i.test(rest[k])) k += 1; k += 1; }
  return k;
}

/** The command a launcher runs: { words } | { alts } | { text, isPs } | { inline } | { code }, or null. `heredoc` is
 *  the stdin text a `<<EOF` gave this command: for a shell or an interpreter without a program, the program. */
function innerOf(verb, rest, heredoc, isPs) {
  const fromStdin = (kind) => (heredoc === undefined ? { code: 'unjudgeable' } : kind === 'inline' ? { inline: heredoc } : { text: heredoc, isPs: kind === 'ps' });
  const after = (k) => (k < rest.length ? { words: rest.slice(k) } : null);
  if (verb === 'start' && !isPs) {
    // cmd's start: `start [/b /min /d dir ...] ["title"] program args`. The first quoted word is the
    // window title, which the quotes no longer show here, so both readings are judged.
    const k = skipSlashSwitches(rest, 0);
    if (k >= rest.length) return null;
    const alts = [rest.slice(k)];
    const k2 = skipSlashSwitches(rest, k + 1);
    if (k2 < rest.length) alts.push(rest.slice(k2));
    return { alts };
  }
  switch (verb) {
    case 'git': {
      const { k, sub } = gitSub(rest);
      if (sub.toLowerCase() === 'bisect' && (rest[k + 1] || '').toLowerCase() === 'run') return after(k + 2);
      return null;
    }
    case 'npx': case 'bunx': case 'pnpx': case 'uvx': {
      let k = 0;
      while (k < rest.length && isOpt(rest[k])) {
        const o = rest[k].toLowerCase();
        if (o === '-c' || o === '--call') return { text: rest[k + 1] || '' };
        if (o === '-p' || o === '--package') k += 1;
        k += 1;
      }
      return after(k);
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const { sub, at } = firstArg(rest);
      if (!['exec', 'dlx', 'x'].includes(sub)) return null;
      let k = at + 1;
      while (k < rest.length && isOpt(rest[k])) { if (rest[k] === '-c' || rest[k] === '--call') return { text: rest[k + 1] || '' }; k += 1; }
      return after(k);
    }
    case 'cmd': {
      const k = rest.findIndex((w) => /^\/\/?[ck]$/i.test(w)); // Git Bash writes `cmd //c` to stop path conversion
      if (k < 0) return rest.length === 0 ? { code: 'unjudgeable' } : null;
      // cmd drops the quotes around one whole command (`cmd /c "npm publish"`); of several words, a quoted one stays whole
      const parts = rest.slice(k + 1);
      return { text: parts.length === 1 ? parts[0] : parts.map((w) => (/\s/.test(w) && !w.includes('"') ? '"' + w + '"' : w)).join(' '), isPs: false };
    }
    case 'bash': case 'sh': case 'zsh': case 'dash': case 'ksh': case 'fish': {
      let k = 0; let c = false;
      while (k < rest.length && isOpt(rest[k]) && rest[k] !== '-' && rest[k] !== '--') {
        if (/^-[a-z]*c[a-z]*$/i.test(rest[k])) c = true;
        if (rest[k] === '-o') k += 1;
        k += 1;
      }
      if (c) return { text: rest[k] || '', isPs: false };
      if (k >= rest.length || rest[k] === '-' || rest.includes('-s')) return fromStdin('sh'); // reads commands from stdin
      return null; // runs a script file
    }
    case 'powershell': case 'pwsh': {
      for (let k = 0; k < rest.length; k++) {
        const o = rest[k].toLowerCase();
        if (!isOpt(o)) return { text: rest.slice(k).join(' '), isPs: true };
        if (/^-e(c|n\w*)?$/.test(o) || o.startsWith('-encoded')) return { code: 'unjudgeable' };
        if (o.length >= 2 && '-command'.startsWith(o)) return { text: rest.slice(k + 1).join(' '), isPs: true };
        if (o.length >= 2 && '-file'.startsWith(o)) return null;
        if (/^-(ex|ep|w|config|o|in|wd|settings|custom)/.test(o)) k += 1;
      }
      return fromStdin('ps');
    }
    case 'wsl': {
      let k = 0;
      while (k < rest.length && isOpt(rest[k])) {
        const o = rest[k].toLowerCase();
        if (o === '-e' || o === '--exec' || o === '--') { k += 1; break; }
        if (['-d', '--distribution', '-u', '--user', '--cd'].includes(o)) k += 1;
        k += 1;
      }
      return k < rest.length ? { words: rest.slice(k) } : { code: 'unjudgeable' };
    }
    case 'start-process': case 'saps': case 'start': {
      if (rest.some((w, k) => /^-verb$/i.test(w) && /^runas$/i.test(rest[k + 1] || ''))) return { code: 'outside_folder' };
      const words = [];
      for (let k = 0; k < rest.length; k++) {
        const o = rest[k].toLowerCase();
        if (isOpt(o)) { if (/^-(workingdirectory|windowstyle|verb|redirectstandard\w*|credential)$/.test(o)) k += 1; continue; }
        words.push(...rest[k].split(/[\s,]+/).filter(Boolean));
      }
      return words.length ? { words } : null;
    }
    case 'find': {
      if (rest.some((w) => /^-delete$/.test(w))) return { code: 'delete' };
      const k = rest.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w));
      return k >= 0 ? after(k + 1) : null;
    }
    default: break;
  }
  if (INTERPRETERS.has(verb)) {
    if (rest.length === 0 || rest[0] === '-') return fromStdin('inline'); // reads a program from stdin
    for (let k = 0; k < rest.length && isOpt(rest[k]); k++) {
      const o = rest[k];
      if (/^(-e|--eval|-p|--print|-c)$/.test(o)) return { inline: rest[k + 1] || '', args: rest.slice(k + 2) };
      if (o === '-m' && rest[k + 1]) return { words: rest.slice(k + 1) };
    }
  }
  return null;
}

// F2: inline code that writes files or sends data
const INLINE_WRITE_RE = /\b(?:writeFile|appendFile|copyFile|cp|createWriteStream|symlink|link|rename|mkdir|mkdtemp|truncate|open)Sync\b|\b(?:writeFile|appendFile|copyFile|createWriteStream|symlink|rename|mkdir|truncate|cp)\s*\(|\.write_(?:text|bytes)\s*\(|\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\bshutil\.\w+|\bos\.(?:rename|replace|makedirs|mkdir|symlink|link|truncate)\b|\.(?:touch|symlink_to|hardlink_to)\s*\(|\bDeno\.(?:write\w*|create|mkdir|rename|copyFile|symlink)\b|\bBun\.write\b/;
const INLINE_HOME_RE = /homedir\s*\(|expanduser|Path\.home\s*\(|getenv\s*\(|\bos\.environ\b|process\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|SYSTEMROOT|WINDIR|HOMEDRIVE|HOMEPATH)\b|process\.env\[/;
const INLINE_NET_RE = /\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\b(?:net|tls)\.(?:connect|createConnection)\b|\bdgram\b|\bWebSocket\b|\burllib\b|\burlopen\b|\brequests\.|\bhttpx\.|\bsocket\.|\baxios\b|\bXMLHttpRequest\b|\bhttp\.client\b|\b(?:ftplib|smtplib|paramiko)\b|\bDeno\.connect\b|\bundici\b/;
const INLINE_UPLOAD_RE = /\bmethod\s*[:=]\s*['"](?!(?:GET|HEAD)['"])\w+|\bbody\s*:|\b(?:data|json|files)\s*=(?![>=])|\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\b|\.(?:post|put|patch)\s*\(|\burlopen\s*\([^)]*,|\bRequest\s*\([^)]*,|\bsend(?:all)?\s*\(|\b(?:net|tls)\.(?:connect|createConnection)\b|\bdgram\b|\bWebSocket\b|\bsocket\.socket\b|\b(?:smtplib|ftplib|paramiko)\b|\bDeno\.connect\b/i;

/** The string literals of inline code, with \\, \n, \t, \r and escaped quotes turned into what they mean. */
function inlineLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    out.push({ quote: m[1], text: m[2].replace(/\\(.)/g, (s, c) => ({ n: '\n', t: '\t', r: '\r', 0: '\0' }[c] ?? c)) });
  }
  return out;
}

// A literal that names a file: a drive path, ~, a `..` step, a rooted path of two or more parts
// ('/.claude/CLAUDE.md'; not CSS or JS comment text, and not '/events.jsonl' glued to a folder), or a
// relative path with a folder or an extension.
function inlinePath(lit) {
  if (lit.length < 2 || lit.length > 400 || /[\0-\x1f"<>|*?`]/.test(lit) || /:\/\//.test(lit)) return false;
  if (/^[A-Za-z]:[\\/][^\\/]/.test(lit) || /^~(?:$|[\\/])/.test(lit) || /(?:^|[\\/])\.\.(?:$|[\\/])/.test(lit)) return true;
  // a rooted literal: a known root, or a dot folder glued to a computed folder ('/.claude/x'); an
  // '/api/x' route or regex text is not a file
  if (/^[\\/]/.test(lit)) return /^[\\/][\w.@~ -]+(?:[\\/][\w.@~ ()-]+)+[\\/]?$/.test(lit) && (POSIX_ROOT_RE.test(lit) || /^[\\/]\.\w/.test(lit));
  return !/\s/.test(lit) && !/^[A-Za-z]:/.test(lit) && /[\\/]|\.\w{1,8}$/.test(lit);
}

/** Inline program text (`node -e`, `python -c`, a heredoc): secrets, settings, deletes, uploads, writes,
 *  and shell strings it runs. A write is routine only when every path literal lands in the project or temp. */
function judgeInline(code, ctx) {
  if (credentialText(code)) return 'credentials';
  if (/\b(?:rmSync|rmdirSync|unlinkSync|rimraf|rmtree|os\.remove|os\.unlink)\b/.test(code)) return 'delete';
  if (/\.claude[\\/]+[^'"`\s]*settings[^'"`\s]*\.json|\.mcp\.json|\.claude\.json/i.test(code)) return 'settings';
  const literals = inlineLiterals(code);
  if (INLINE_NET_RE.test(code) && INLINE_UPLOAD_RE.test(code)) {
    const hosts = [...code.matchAll(/\b(?:https?|wss?|ftp):\/\/(\[[^\]]+\]|[^/'"`\s:]+)/gi)].map((m) => m[1])
      .concat([...code.matchAll(/\bhost(?:name)?\s*[:=]\s*['"]([^'"]+)['"]/gi)].map((m) => m[1]));
    if (hosts.length === 0 || hosts.some((h) => !isLoopbackHost(h))) return 'outbound';
  }
  if (INLINE_WRITE_RE.test(code)) {
    for (const { quote, text } of literals) {
      if (quote === '`' && /^\$\{[^}]*\}[\\/]/.test(text)) return 'unjudgeable'; // a template path with a computed root
      if (!inlinePath(text)) continue;
      const abs = locate(text, ctx.base, ctx);
      const g = abs && gateKindAt(abs, ctx);
      if (g) return g;
      if (!writable(ctx, abs)) return 'outside_folder';
    }
    if (INLINE_HOME_RE.test(code)) return 'unjudgeable'; // writes under a folder computed from the home folder or the environment
  }
  if (!/child_process|exec(File)?(Sync)?\s*\(|spawn(Sync)?\s*\(|os\.system|subprocess|Popen|Deno\.Command|Bun\.spawn/.test(code)) return null;
  for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (!/^[A-Za-z][\w.-]*\s/.test(m[2])) continue; // only strings that look like a command line
    const c = judgeText(m[2], false, ctx, ctx.depth + 1);
    if (c && c !== 'unjudgeable') return c;
  }
  return null;
}

// ---------------------------------------------------------------- write-then-run (HIGH-2)

// Files no test runner or build executes. Writing any other kind (code, config, data a test imports) can put
// code in the project that a later `npm test` runs.
const INERT_EXT_RE = /\.(?:md|markdown|txt|log|csv|tsv|rst|adoc|png|jpe?g|gif|webp|bmp|ico|pdf)$/i;
// programs that write the files they are given (also Claude Code's own acceptEdits filesystem commands)
const FILE_WRITE_VERBS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename',
  'rename-item', 'rni', 'tee', 'tee-object', 'touch', 'ln', 'install', 'dd', 'patch', 'unzip', 'tar', '7z', 'expand-archive', 'set-content',
  'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'export-csv', 'export-clixml', 'rsync']);
// git sub-commands that change the working tree: what they bring in is code no run has covered yet
const GIT_TREE_SUBS = new Set(['checkout', 'switch', 'restore', 'reset', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am', 'apply',
  'stash', 'clone', 'submodule', 'worktree', 'read-tree', 'checkout-index', 'mv', 'bisect', 'clean', 'rm']);
// runners: their own output usually is a report or a log. Round 7 (LOW): it still marks the project when it goes into
// a file a run may execute (`npm test > src/out.js`); a report (.json, .xml) or a document does not.
const RUNNER_VERBS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'tsc', 'vitest', 'eslint', 'vite', 'jest', 'mocha']);
const REPORT_EXT_RE = /\.(?:json|xml)$/i;
const isInert = (p) => INERT_EXT_RE.test(String(p).replace(/[\\/]+$/, ''));
// Round 7: the package-manager sub-commands that change package.json or node_modules, and the ones of pip and uv
const PM_WRITE_SUBS = new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un', 'r', 'link', 'ln', 'rebuild', 'rb',
  'pkg', 'init', 'create', 'dedupe', 'ddp', 'prune', 'patch', 'sync', 'import']);
// Round 7: web clients that save what they fetch (curl -o, Invoke-WebRequest -OutFile; wget saves by default)
const savesDownload = (verb, rest) => (verb === 'wget' ? !rest.some((w, k) => /^(?:--spider|-O-?|--output-document(?:=-)?)$/.test(w) && (w.endsWith('-') || rest[k + 1] === '-'))
  : verb === 'curl' ? rest.some((w) => /^(?:-[a-zA-Z]*[oO]|--output(?:-dir)?|--remote-name(?:-all)?|--create-dirs)(?:=|$)/.test(w))
    : /^(?:iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(verb) ? rest.some((w) => psParam(w.toLowerCase().split(':')[0], 'outfile', 2)) : false);

/**
 * Where a tool call writes a file a test run or build may execute: absolute paths (or the working folder, or
 * '*' when even that is unknown), [] when it writes none. Used by permissions/store.mjs for every card and for
 * every tool call it sees in the stream (also edits Claude Code accepted itself), and by classifyHardGate for a
 * command that writes and then runs. Conservative: a command it cannot read counts as a write. Never throws.
 */
export function codeWriteTargets(toolName, input, { cwd = null, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const root = typeof cwd === 'string' && cwd && !isUncPath(cwd) ? path.resolve(cwd) : null;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
    const name = str(toolName);
    const ctx = { cwd: root, home, tmp: path.resolve(tmp) };
    if (EDIT_TOOLS.has(name)) {
      const p = str(input.file_path) || str(input.notebook_path);
      if (!p || isInert(p)) return [];
      return [isUncPath(p) ? '*' : locate(p, root, ctx) || root || '*'];
    }
    return SHELL_TOOLS.has(name) ? shellWrites(str(input.command), name === 'PowerShell', ctx, 0) : [];
  } catch {
    return [root || '*'];
  }
}

// Round 8 (LOW): package scripts that only check (their output is a report), whatever the package manager.
const CHECK_SCRIPTS = new Set(['test', 't', 'tst', 'lint', 'typecheck']);

/**
 * Round 8 (LOW): where a card writes code once the owner allows it and it runs: what codeWriteTargets names (the write of
 * a waiting Write card, a `cargo add`, ...) and, for a shell command, its folder when it runs a package script other
 * than test, lint or typecheck (`npm run fix`, `npm run build`, `yarn gen`) or `vite build`. Those two are judged at the
 * owner's answer only: an auto-allowed `vite build` or build script that the allow-list passed marks nothing (it bundles
 * code that was already there). Never throws.
 */
export function postRunWrites(toolName, input, { cwd = null, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const out = codeWriteTargets(toolName, input, { cwd, home, tmp });
  try {
    const name = str(toolName);
    if (!SHELL_TOOLS.has(name) || !input || typeof input !== 'object') return out;
    const root = typeof cwd === 'string' && cwd && !isUncPath(cwd) ? path.resolve(cwd) : null;
    return runWrites(str(input.command), name === 'PowerShell', 0) ? out.concat(root || '*') : out;
  } catch {
    return out.concat('*');
  }
}

function runWrites(text, isPs, depth) {
  if (!text) return false;
  if (depth > MAX_DEPTH || text.length > MAX_COMMAND_CHARS) return true;
  let lexed;
  try { lexed = lexCommand(text, isPs); } catch { return true; }
  return lexed.segments.some((seg) => segmentRunWrites(seg.words, seg.heredoc, isPs, depth)) || lexed.subs.some((s) => runWrites(s, isPs, depth + 1));
}

function segmentRunWrites(words, heredoc, isPs, depth) {
  if (depth > MAX_DEPTH) return true;
  const vi = findVerb(words);
  if (vi < 0) return false;
  const verb = verbName(words[vi]);
  const rest = words.slice(vi + 1);
  if (verb === 'vite') return firstArg(rest).sub === 'build';
  if (['npm', 'pnpm', 'yarn', 'bun', 'cnpm'].includes(verb)) {
    const { sub, at } = firstArg(rest);
    const script = /^(?:run|run-script|rum|urn)$/.test(sub) ? (rest.slice(at + 1).find((w) => !isOpt(w)) || '').toLowerCase()
      : verb === 'npm' ? (['start', 'restart', 'stop'].includes(sub) ? sub : '') : sub;
    if (script && !CHECK_SCRIPTS.has(script) && !PM_WRITE_SUBS.has(script) && !['exec', 'dlx', 'x'].includes(script)) return true;
  }
  const inner = innerOf(verb, rest, heredoc, isPs);
  if (!inner || inner.code || inner.inline !== undefined) return false;
  if (inner.text !== undefined) return runWrites(inner.text, inner.isPs ?? isPs, depth + 1);
  return (inner.alts || [inner.words]).some((alt) => segmentRunWrites(alt, undefined, isPs, depth + 1));
}

function shellWrites(text, isPs, ctx, depth) {
  if (!text) return [];
  const here = ctx.cwd || '*';
  if (depth > MAX_DEPTH || text.length > MAX_COMMAND_CHARS) return [here];
  let lexed;
  try { lexed = lexCommand(text, isPs); } catch { return [here]; }
  const out = [];
  if (isPs && /::\s*(?:write|append|copy|move|create|replace)\w*\s*\(/i.test(text)) out.push(here); // [IO.File]::WriteAllText(...)
  for (const seg of lexed.segments) out.push(...segmentWrites(seg.words, seg.redirects, seg.heredoc, isPs, ctx, depth));
  for (const sub of lexed.subs) out.push(...shellWrites(sub, isPs, ctx, depth + 1));
  return out;
}

function segmentWrites(words, redirects, heredoc, isPs, ctx, depth) {
  const here = ctx.cwd || '*';
  const vi = findVerb(words);
  const verb = vi >= 0 ? verbName(words[vi]) : '';
  const rest = vi >= 0 ? words.slice(vi + 1) : [];
  const out = [];
  const runner = RUNNER_VERBS.has(verb) || (verb === 'node' && rest.includes('--test'));
  for (const t of redirects) {
    if (NULL_DEVICES.has(t.toLowerCase()) || isInert(t) || (runner && REPORT_EXT_RE.test(t))) continue;
    out.push(locate(t, ctx.cwd, ctx) || here);
  }
  if (vi < 0 || depth > MAX_DEPTH) return out;
  const plain = rest.filter((w) => !isOpt(w));
  const inPlace = (verb === 'sed' && rest.some((w) => /^(?:-[a-z]*i|--in-place)/i.test(w))) || (['perl', 'ruby'].includes(verb) && rest.some((w) => /^-[a-z]*i/i.test(w)))
    || (/^g?awk$/.test(verb) && rest.some((w, k) => /^(?:-i\s*inplace|-iinplace|--inplace|--include=inplace)$/.test(w) || (w === '-i' && /^inplace$/.test(rest[k + 1] || ''))));
  if (FILE_WRITE_VERBS.has(verb) || inPlace) {
    const folderOnly = ['new-item', 'ni'].includes(verb) && rest.some((w, k) => /^-itemtype$/i.test(w) && /^directory$/i.test(rest[k + 1] || ''));
    if (!folderOnly && (plain.length === 0 || plain.some((w) => !isInert(w)))) out.push(here);
    return out;
  }
  // a delete, a download that saves a file, and a package-manager change also change what a run executes
  if (DELETE_VERBS.has(verb) || savesDownload(verb, rest)) return out.concat(here);
  if (['npm', 'pnpm', 'yarn', 'bun', 'cnpm', 'pip', 'pip3', 'uv', 'poetry'].includes(verb) && PM_WRITE_SUBS.has(firstArg(rest).sub)) return out.concat(here);
  if (verb === 'git' && GIT_TREE_SUBS.has(gitSub(rest).sub.toLowerCase())) return out.concat(here);
  if (codeRewriter(verb, rest)) return out.concat(here); // round 8 (LOW)
  const inner = innerOf(verb, rest, heredoc, isPs);
  if (!inner || inner.code) return out;
  if (inner.inline !== undefined) return INLINE_WRITE_RE.test(inner.inline) ? out.concat(here) : out;
  if (inner.text !== undefined) return out.concat(shellWrites(inner.text, inner.isPs ?? isPs, ctx, depth + 1));
  for (const alt of inner.alts || [inner.words]) out.push(...segmentWrites(alt, [], undefined, isPs, ctx, depth + 1));
  return out;
}

// Round 8 (LOW): programs that rewrite the project's code or its dependencies when they run. None of them is on the
// allow-list, so the card itself waits; after it the folder is marked, so a later runner asks ('wrote_code').
const CARGO_WRITE_SUBS = new Set(['add', 'remove', 'rm', 'update', 'upgrade', 'fix', 'fmt', 'new', 'init', 'vendor', 'generate-lockfile']);
const GO_WRITE_SUBS = new Set(['get', 'mod', 'generate', 'fmt', 'fix', 'work']);
const DOTNET_WRITE_SUBS = new Set(['add', 'remove', 'new', 'restore', 'format', 'tool']);
const PACKAGE_WRITE_SUBS = Object.freeze({ composer: ['install', 'update', 'require', 'remove', 'dump-autoload', 'create-project'], bundle: ['install', 'update', 'add', 'lock'] });
const ONLY_INFO = (rest) => rest.length > 0 && rest.every((w) => VERSION_FLAGS.test(w) || /^--?(?:info|list-\w+)$/.test(w));

/** True when `verb rest` rewrites code or dependencies in its folder when it runs. */
function codeRewriter(verb, rest) {
  const has = (re) => rest.some((w) => re.test(w));
  const sub = firstArg(rest).sub;
  switch (verb) {
    case 'cargo': return CARGO_WRITE_SUBS.has(sub);
    case 'go': return GO_WRITE_SUBS.has(sub);
    case 'dotnet': return DOTNET_WRITE_SUBS.has(sub);
    case 'composer': case 'bundle': return PACKAGE_WRITE_SUBS[verb].includes(sub);
    case 'cmake': return rest.length > 0 && !ONLY_INFO(rest);
    case 'make': case 'gmake': case 'nmake': case 'mingw32-make':
      return !ONLY_INFO(rest) && !has(/^(?:--dry-run|--just-print|--recon|--question|--print-data-base|-[A-Za-z]*[nq][A-Za-z]*)$/);
    case 'gradle': case 'gradlew': case 'mvn': case 'mvnw': return !ONLY_INFO(rest);
    case 'eslint': return has(/^--fix(?:=|$)/);
    case 'prettier': return has(/^(?:--write|-w)$/);
    case 'tsc': return !ONLY_INFO(rest) && !has(/^--(?:noEmit|showConfig|listFilesOnly)(?:=true)?$/);
    case 'vitest': case 'jest': return has(/^(?:-u|--update|--updateSnapshot)$/);
    default: return false;
  }
}

function programRule(verb, raw, rest, ctx) {
  if (DELETE_VERBS.has(verb)) return 'delete';
  if (UNJUDGEABLE_VERBS.has(verb)) return 'unjudgeable';
  if (OUTBOUND_VERBS.has(verb)) return 'outbound';
  if (CREDENTIAL_VERBS.has(verb)) return 'credentials';
  if (MACHINE_VERBS.has(verb)) return 'outside_folder';
  if (PUBLISH_VERBS.has(verb)) return 'publish';
  if (['env', 'set', 'export'].includes(verb) && rest.every(isOpt)) return 'credentials'; // dumps every variable
  if (rest.some((w) => /^env:\\?\*?$/i.test(w))) return 'credentials';
  const { sub, at } = firstArg(rest);
  const next = at >= 0 ? (rest.slice(at + 1).find((w) => !isOpt(w)) || '').toLowerCase() : '';
  const has = (re) => rest.some((w) => re.test(w));
  switch (verb) {
    case 'git': return gitRule(rest);
    case 'gh': return ghRule(sub, next, rest);
    case 'npm': case 'pnpm': case 'yarn': case 'bun': case 'cnpm': return pmRule(verb, sub, next, rest);
    case 'pip': case 'pip3':
      if (!INSTALL_SUBS.has(sub)) return null;
      if (has(/^(-t|--target|--prefix|--root)$/) || inside(ctx.cwd, locate(raw, ctx.base, ctx)) && /[\\/]/.test(raw)) return null; // a project venv or target
      return 'outside_folder';
    case 'uv': return (sub === 'tool' && INSTALL_SUBS.has(next)) || has(/^--system$/) ? 'outside_folder' : null;
    case 'docker': case 'podman':
      if (sub === 'push' || (sub === 'compose' && next === 'push')) return 'publish';
      if (sub === 'login' || sub === 'logout') return 'credentials';
      if (has(/^(-H|--host)$/)) return 'production';
      if (['rm', 'rmi'].includes(sub) || next === 'prune' || next === 'rm' || (sub === 'compose' && next === 'down' && has(/^(-v|--volumes|--rmi)$/))) return 'delete';
      return null;
    case 'claude':
      if (['login', 'logout', 'setup-token'].includes(sub)) return 'credentials';
      if (['config', 'mcp', 'plugin', 'plugins', 'marketplace', 'update', 'install', 'migrate-installer'].includes(sub)) return 'settings';
      return has(/^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$/) || has(/^bypassPermissions$/) ? 'settings' : null;
    case 'curl': case 'wget': case 'iwr': case 'irm': case 'invoke-webrequest': case 'invoke-restmethod': case 'http': case 'https': case 'xh':
      return httpRule(verb, rest, ctx.isPs);
    case 'rsync': return has(/^(?![A-Za-z]:[\\/])[^\s\\/:]+:/) ? 'outbound' : null;
    case 'invoke-command': case 'icm': case 'enter-pssession': case 'new-pssession': return has(/^-(computername|cn|session|hostname)$/i) ? 'outbound' : null;
    case 'reg': return sub === 'delete' ? 'delete' : ['add', 'import', 'copy', 'load', 'restore', 'unload'].includes(sub) ? 'outside_folder' : null;
    case 'schtasks': return has(/^\/(create|delete|change|run|end)$/i) ? 'outside_folder' : null;
    case 'sc': return ['create', 'config', 'delete', 'start', 'stop', 'failure'].includes(sub) ? 'outside_folder' : null;
    case 'set-itemproperty': case 'new-itemproperty': case 'sp': return has(/^(HK\w*:|Registry::)/i) ? 'outside_folder' : null;
    case 'dotnet':
      if (sub === 'nuget' && next === 'push') return 'publish';
      return sub === 'tool' && INSTALL_SUBS.has(next) && has(/^(-g|--global|--tool-path)$/) ? 'outside_folder' : null;
    case 'code': case 'code-insiders': case 'cursor': return has(/^--(install|uninstall)-extension$/) ? 'outside_folder' : null;
    default: break;
  }
  if (SYSTEM_INSTALLERS.has(verb)) {
    const installs = verb === 'cargo' ? ['install', 'uninstall'] : verb === 'go' ? ['install'] : [...INSTALL_SUBS];
    if (installs.includes(sub)) return 'outside_folder';
  }
  if (Object.hasOwn(CLOUD_TOOLS, verb)) {
    if (sub === '') return rest.length > 0 && rest.every((w) => VERSION_FLAGS.test(w)) ? null : 'production';
    return CLOUD_TOOLS[verb].includes(sub) || VERSION_FLAGS.test(sub) ? null : 'production';
  }
  if (!GENERIC_EXEMPT.has(verb)) {
    if (sub === 'deploy') return 'production';
    if (['publish', 'unpublish', 'push', 'upload', 'submit', 'release'].includes(sub)) return 'publish';
  }
  return null;
}

/** git's global options, then the sub-command: `{ k, sub, risky }`. `risky`: a `-c` key that runs a
 *  program or redirects data (alias, sshCommand, hooksPath, a helper, ...), `--config-env` or `--exec-path=`. */
function gitSub(rest) {
  let k = 0; let risky = false;
  while (k < rest.length && isOpt(rest[k])) {
    const o = rest[k];
    if (o === '-c') { if (GIT_RISKY_CONFIG_RE.test(rest[k + 1] || '')) risky = true; k += 2; continue; }
    if (/^--config-env\b|^--exec-path=/.test(o)) risky = true;
    if (/^(-C|--git-dir|--work-tree|--namespace|--config-env)$/.test(o)) k += 1;
    k += 1;
  }
  return { k, sub: rest[k] || '', risky };
}

function gitRule(rest) {
  const { k, sub: raw, risky } = gitSub(rest);
  if (risky || isDynamic(raw)) return 'unjudgeable';
  const sub = raw.toLowerCase();
  const args = rest.slice(k + 1);
  const has = (re) => args.some((a) => re.test(a));
  const first = (args.find((a) => !isOpt(a)) || '').toLowerCase();
  switch (sub) {
    case 'push': case 'send-pack': case 'http-push': return 'push';
    case 'send-email': case 'imap-send': return 'outbound';
    case 'submodule': return first === 'foreach' ? 'unjudgeable' : null; // runs any command in every submodule
    case 'rebase': return has(/^(-x|--exec)(=|$)/) ? 'unjudgeable' : null;
    case 'clean': case 'rm': case 'filter-branch': case 'filter-repo': return 'delete';
    case 'reset': return has(/^--(hard|merge|keep)$/) ? 'delete' : null;
    case 'checkout': return has(/^(--|\.|-f|--force)$/) ? 'delete' : null;
    case 'restore': return has(/^(--staged|-S)$/) && !has(/^(--worktree|-W)$/) ? null : 'delete';
    case 'stash': return /^(drop|clear)$/.test(first) ? 'delete' : null;
    case 'branch': return has(/^(-d|--delete|-[a-zA-Z]*D[a-zA-Z]*)$/) ? 'delete' : null;
    case 'tag': return has(/^(-d|--delete)$/) ? 'delete' : null;
    case 'worktree': return /^(remove|prune)$/.test(first) ? 'delete' : null;
    case 'update-ref': return has(/^-d$/) ? 'delete' : null;
    case 'reflog': return /^(expire|delete)$/.test(first) ? 'delete' : null;
    case 'config': return has(/^--(global|system)$/) || GIT_RISKY_CONFIG_RE.test(first) ? 'settings' : null;
    case 'credential': case 'credential-store': case 'credential-manager': return 'credentials';
    default: return GIT_LOCAL_SUBS.has(sub) ? null : 'unjudgeable'; // an alias, an extension or a typo is not judged
  }
}

const GH_READ = Object.freeze({
  pr: ['view', 'list', 'status', 'diff', 'checks'], issue: ['view', 'list', 'status'], repo: ['view', 'list', 'clone'],
  run: ['view', 'list', 'watch', 'download'], release: ['view', 'list', 'download'], workflow: ['view', 'list'], gist: ['view', 'list'],
  label: ['list'], search: null, browse: null, status: null, version: null, help: null, '': null,
});

function ghRule(sub, action, rest) {
  if (['auth', 'secret', 'variable', 'ssh-key', 'gpg-key'].includes(sub)) return 'credentials';
  if (sub === 'api') {
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k];
      const method = /^(?:-X|--method)$/.test(w) ? rest[k + 1] || '' : (/^(?:-X|--method=)(.+)$/.exec(w) || [])[1];
      if (method !== undefined && !/^(GET|HEAD)$/i.test(method)) return 'publish';
      if (/^(-f|-F|--field|--raw-field|--input)$/.test(w) || /^--(field|raw-field|input)=/.test(w)) return 'publish';
    }
    return null;
  }
  if (!Object.hasOwn(GH_READ, sub)) return 'publish';
  const allowed = GH_READ[sub];
  return allowed === null || allowed.includes(action) ? null : 'publish';
}

function pmRule(verb, sub, next, rest) {
  const has = (re) => rest.some((w) => re.test(w));
  const s = verb === 'yarn' && sub === 'npm' ? next : sub;
  if (/^(publish|unpublish|deprecate|dist-tags?|owner|access|team|org|hook|star|unstar)$/.test(s)) return 'publish';
  if (/^(login|logout|adduser|add-user|token|profile)$/.test(s)) return 'credentials';
  if (verb === 'yarn' && sub === 'global') return 'outside_folder';
  if (/^(install|i|add|update|up|upgrade|uninstall|remove|rm|un|link|ln)$/.test(sub) && has(/^(-g|--global|--location=global)$/)) return 'outside_folder';
  if ((sub === 'config' && /^(set|delete|edit|rm)$/.test(next)) || sub === 'set') return 'outside_folder'; // writes the user's .npmrc
  const script = /^(run|run-script|rum|urn)$/.test(sub) ? next : verb === 'npm' ? '' : sub;
  const m = /(?:^|[:_-])(deploy|prod|production|ship|publish|release|upload)(?:$|[:_-])/.exec(script);
  if (m) return ['deploy', 'prod', 'production', 'ship'].includes(m[1]) ? 'production' : 'publish';
  return null;
}

// curl's short options that take a value (attached `-d@x` or as the next word); in a group such as
// `-sLd` the first of them takes the rest of the word (F3)
const CURL_VALUE_FLAGS = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz');
const AUTH_HEADER_RE = /authorization|cookie|api-key|token/i;

/** True when PowerShell would bind parameter word `pn` (lower case, no `:value`) to `-full`: a unique prefix of at least `min` characters. */
const psParam = (pn, full, min) => pn.length >= min && ('-' + full).startsWith(pn);

function httpRule(verb, rest, isPs) {
  let upload = false; let auth = false;
  const hosts = [];
  const nonGet = (m) => m !== undefined && !/^(GET|HEAD)$/i.test(m);
  const psWeb = /^(iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(verb) || (isPs && (verb === 'curl' || verb === 'wget')); // aliases in Windows PowerShell 5.1
  const httpie = /^(http|https|xh)$/.test(verb);
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    const lw = w.toLowerCase();
    if (/^https?:\/\//i.test(w)) { try { hosts.push(new URL(w).hostname); } catch { hosts.push('?'); } continue; }
    if (verb === 'curl' && /^-[^-]/.test(w)) { // grouped or attached short options: -sd @x, -d@x, -F"f=@x", -sX PUT
      for (let j = 1; j < w.length; j++) {
        const f = w[j];
        if ('dFTK'.includes(f)) upload = true; // -K: a config file can hold any option, an upload too
        if ('ub'.includes(f)) auth = true;
        if (!CURL_VALUE_FLAGS.has(f)) continue;
        const val = j + 1 < w.length ? w.slice(j + 1) : rest[k + 1] || '';
        if (f === 'X' && nonGet(val)) upload = true;
        if (f === 'H' && AUTH_HEADER_RE.test(val)) auth = true;
        break;
      }
    }
    if (psWeb && isOpt(w)) { // PowerShell binds any unique prefix: -Meth, -Bo, -In, -Fo; `-Method:Post` too
      const pn = lw.split(':')[0];
      const val = lw.includes(':') ? w.slice(w.indexOf(':') + 1) : rest[k + 1];
      if (psParam(pn, 'body', 2) || psParam(pn, 'infile', 2) || psParam(pn, 'form', 2)) upload = true;
      if ((psParam(pn, 'method', 3) || psParam(pn, 'custommethod', 3)) && nonGet(val)) upload = true;
      if (psParam(pn, 'credential', 3) || psParam(pn, 'token', 3) || psParam(pn, 'authentication', 3) || psParam(pn, 'usedefaultcredentials', 5) || psParam(pn, 'websession', 3)) auth = true;
      if (psParam(pn, 'headers', 3) && AUTH_HEADER_RE.test(val || '')) auth = true;
    }
    if (httpie && !isOpt(w)) { // HTTPie items: name=value, name:=json and name@file send a body; @file is the body
      if (/^@/.test(w) || /^[^=:@\s/]+(?::=|=(?!=)|@)/.test(w)) upload = true;
      if (/^(?:authorization|cookie|x-api-key|[\w-]*token[\w-]*):/i.test(w)) auth = true;
    }
    // short curl flags are case-sensitive: -f is --fail, -x is --proxy
    if (['-d', '-F', '-T'].includes(w) || /^(--data\S*|--form\S*|--upload-file|--json|--post-data|--post-file|--body-data|--body-file|-body|-infile|-form)$/i.test(w.split('=')[0])) upload = true;
    const method = w === '-X' || /^(--request|-method)$/i.test(w) ? rest[k + 1] : (/^-X(.+)$/.exec(w) || /^(?:--request=|--method=|-method:)(.+)$/i.exec(w) || [])[1];
    if (nonGet(method)) upload = true;
    if (/^(POST|PUT|PATCH|DELETE)$/.test(w) && /^(http|https|xh)$/.test(verb)) upload = true;
    if (['-u', '-b', '-a'].includes(w) || /^(--user|--oauth2-bearer|--cookie|-credential|-token|-authentication|--password|--auth)$/i.test(w)) auth = true;
    if ((w === '-H' || /^(--header|-headers)$/i.test(w)) && AUTH_HEADER_RE.test(rest[k + 1] || '')) auth = true;
    if (/^--header=.*(authorization|cookie|api-key|token)/i.test(lw)) auth = true;
    if (/^-uri$|^--url$/i.test(w) && rest[k + 1]) { try { hosts.push(new URL(rest[k + 1]).hostname); } catch { hosts.push('?'); } k += 1; }
    if (!isOpt(w) && !/^https?:/i.test(w) && /^[\w.-]+:\d+(\/|$)/.test(w)) { try { hosts.push(new URL('http://' + w).hostname); } catch { /* not a host */ } }
  }
  const remote = hosts.length === 0 || hosts.some((h) => !isLoopbackHost(h));
  if (auth) return 'credentials'; // sending a cookie or a key is credential use, also to this computer (the gateway)
  if (upload && remote) return 'outbound';
  return null;
}

// ---------------------------------------------------------------- paths

function readOnly(verb, rest) {
  if (verb === 'git') { const g = gitSub(rest); return !g.risky && GIT_READ_SUBS.has(g.sub.toLowerCase()); }
  if (verb === 'sed') return !rest.some((w) => /^(-i|--in-place)/.test(w));
  if (verb === 'find') return !rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  return READ_ONLY.has(verb);
}

/** Where a path really points: an absolute path, or null when it cannot be known (unknown variable, unknown folder). */
function locate(p, base, ctx) {
  let s = p;
  const pwd = /^(?:\$\(pwd\)|`pwd`)(?=$|[\\/])/.exec(s);
  if (pwd) { if (!base) return null; s = base + s.slice(pwd[0].length); }
  if (/^(?:\$\(|`)/.test(s)) return null; // any other substitution decides where it points
  if (s === '~' || /^~[\\/]/.test(s)) s = ctx.home + s.slice(1);
  const v = /^(?:\$env:(\w+)|\$\{(\w+)\}|\$(\w+)|%(\w+)%)/i.exec(s);
  if (v) {
    if (s.length > v[0].length && !/^[\\/]/.test(s.slice(v[0].length))) return null; // $HOME.bak, ${HOME}x
    const name = (v[1] || v[2] || v[3] || v[4]).toUpperCase();
    const known = { HOME: ctx.home, USERPROFILE: ctx.home, TEMP: ctx.tmp, TMP: ctx.tmp, TMPDIR: ctx.tmp, PWD: base }[name];
    if (!known) return null;
    s = known + s.slice(v[0].length);
  }
  if (WIN) {
    if (/^\/tmp(?=$|\/)/.test(s)) s = ctx.tmp + s.slice(4); // Git Bash /tmp is the user's temp folder
    // round 11b (I3): only Git Bash /c/... is a drive; /mnt/c and /cygdrive/c are no mounts there, so not judged
    if (/^\/(?:mnt|cygdrive)(?=$|\/)/i.test(s)) return null;
    const m = /^\/([a-zA-Z])(?=$|\/)(.*)$/.exec(s);
    if (m) s = m[1].toUpperCase() + ':/' + m[2].replace(/^\//, '');
  }
  const abs = path.isAbsolute(s) ? path.resolve(s) : base ? path.resolve(base, s) : null;
  // Escalation round: `link/../x` names two files. A Windows program (node, PowerShell) takes the parent
  // of the link itself; a Git Bash program (cat, grep, a `>` redirect) and every program on Linux or
  // macOS takes the parent of where the link points. When the two differ the path is not judged.
  if (abs && !isUncPath(abs) && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s) && !sameWhenFollowed(s, base, abs)) return null;
  return abs;
}

/** True when walking `s` part by part, following each link before a `..` step, ends where the plain reading of it does. */
function sameWhenFollowed(s, base, abs) {
  const rooted = path.isAbsolute(s);
  const start = rooted ? path.parse(abs).root : base;
  let cur = start && !isUncPath(start) ? realLocation(start) : null;
  if (!cur) return false;
  for (const part of (rooted ? s.replace(/^(?:[A-Za-z]:)?[\\/]+/, '') : s).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    cur = part === '..' ? path.dirname(cur) : realLocation(path.join(cur, part));
    if (!cur) return false;
  }
  const plain = realLocation(abs);
  return Boolean(plain) && path.relative(plain, cur) === '';
}

function inside(root, abs) {
  if (!root || !abs) return false;
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Where a path really lands: a junction or symlink on the way is followed (never for a network path).
 *  shortcut: a dangling link is judged by its own path; making one that points outside is itself judged. */
function realOf(abs) {
  if (!abs || isUncPath(abs)) return abs;
  return realLocation(abs) || abs;
}

/** Where a write or a run may land without a card: the project folder, or the OS temp folder (scratch). */
function writable(ctx, abs) {
  if (!abs || isUncPath(abs)) return false;
  const real = realOf(abs);
  return inside(ctx.realCwd, real) || inside(ctx.realTmp, real);
}

// On Windows a `/word/...` argument is a disk path only under a Git Bash drive (/c/...) or a known root;
// otherwise it is usually a URL path (`node api.cjs GET /api/projects`). `/Users/...` and the other
// Windows top folders are rooted on the current drive (F1c).
const POSIX_ROOT_RE = WIN
  ? /^\/(?:[a-zA-Z]|tmp|etc|usr|var|home|root|opt|bin|mnt|srv|proc|sys|dev|cygdrive)(?:\/|$)|^\/(?:users|windows|programdata|program files(?: \(x86\))?|perflogs|documents and settings|recovery)(?:\/|$)/i
  : /^\/[^/\s]+\/|^\/(?:tmp|etc|usr|var|home|root|opt|bin|mnt|srv|proc|sys)$/;

/** `$NAME`, `${NAME}`, `$env:NAME`, `%NAME%` (or a substitution) at the start of a path word, else null.
 *  In PowerShell `$p.Id` is a property, so a variable counts only when a separator or the end follows. */
function variableRoot(s, isPs) {
  if (/^%\w+%/.test(s)) return 'var';
  if (isPs) return /^\$(?:env:)?\w+(?=$|[\\/])|^\$\{[^}]+\}/i.test(s) ? 'var' : null;
  if (/^\$\{?[A-Za-z_]\w*\}?/.test(s)) return 'var';
  return /^(?:\$\([\s\S]*\)|`[^`]*`)[\\/]/.test(s) ? 'sub' : null;
}

function isPathLike(s, isPs, cmdlet) {
  if (/[\0-\x1f"<>|]/.test(s)) return false; // characters no Windows path has: data such as JSON
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^~(?:$|[\\/])/.test(s) || variableRoot(s, isPs) !== null
    || s === '/' || POSIX_ROOT_RE.test(s) || /(?:^|[\\/])\.\.(?:$|[\\/])/.test(s)
    || (WIN && /^\\[^\\\s]/.test(s)) // \Users\...: the current drive's root, in every shell
    || (cmdlet && /^\/[^/\s]/.test(s)); // a PowerShell cmdlet reads /Users/... as the current drive's root
}

/** The word, and the value of a `--opt=value` / `-Opt:value` word. */
function optionParts(word) {
  const parts = [word];
  if (isOpt(word)) { const m = /^-{1,2}[\w-]+[=:](.+)$/.exec(word); if (m) parts.push(m[1]); }
  return parts;
}

/** Every place one argument word may point to: `{ text, pathLike }`. A loop variable gives each list item. */
function argTargets(word, prev, ctx, cmdlet) {
  const out = [];
  const parts = optionParts(word).filter((p) => !isOpt(p) || p !== word);
  for (const p of parts.flatMap((x) => (ctx.isPs ? x.split(',') : [x]))) { // a comma list is an array only in PowerShell
    if (!p || NULL_DEVICES.has(p.toLowerCase()) || /^[a-z][\w+.-]*:\/\//i.test(p)) continue;
    const loop = !ctx.isPs && /^\$\{?([A-Za-z_]\w*)\}?/.exec(p);
    if (loop && ctx.loops && ctx.loops.has(loop[1])) {
      for (const item of ctx.loops.get(loop[1])) out.push({ text: item + p.slice(loop[0].length), pathLike: true });
      continue;
    }
    const root = variableRoot(p, ctx.isPs);
    if (root && ctx.isPs && (PS_VALUE_OPTS.has(prev.toLowerCase()) || PS_AUTO_VARS.has(p.slice(1).toLowerCase()))) continue; // a value, not a path
    if (root && ctx.http && !HTTP_FILE_OPTS.has(prev)) continue; // `curl -s $URL`: the variable is the address; `-o $OUT` stays a path
    if (root && valueOption(prev, ctx.isPs)) continue; // `--text "$t"`, `--run $R`: a value; `--root $P`, `-Destination $d` stay paths
    out.push({ text: p, pathLike: isPathLike(p, ctx.isPs, cmdlet) });
  }
  return out;
}

/** A named option (`--name` in sh, `-Name` in PowerShell) whose name does not say it takes a file or folder. */
function valueOption(prev, isPs) {
  const m = (isPs ? /^-([A-Za-z][\w-]*)$/ : /^--([A-Za-z][\w-]*)$/).exec(prev);
  return Boolean(m) && !/file|path|dir|folder|out|root|dest|target|config|cwd|log|cache|home|prefix|input|^in$|src|source|save|write|store|db|repo|work|tree|link|lib|module|script|plugin|cert|key|location|tmp|temp/i.test(m[1]);
}

function writeTarget(t, ctx, append = false) {
  if (NULL_DEVICES.has(t.toLowerCase())) return null;
  if (isRemoteUnc(t)) return 'outbound';
  if (isDeviceName(t)) return 'outside_folder'; // `> COM1` writes to a serial port
  if (SETTINGS_RE.test(slashLower(t)) && !GIT_HOOK_RE.test(slashLower(t))) return 'settings'; // a git hook: gateKindAt below
  const abs = locate(t, ctx.base, ctx);
  if (!abs) return 'unjudgeable';
  const g = gateKindAt(abs, ctx);
  if (g === 'auto_run' && append && memoryLog(abs, ctx)) return null; // Forge's own append path (see MEMORY_LOG_RE)
  return g || (writable(ctx, abs) ? null : 'outside_folder');
}

// the memory files Forge's own end-of-run steps add to (/forge step 12, the Bosses' lesson lines). A
// redirect that only APPENDS to one of them (`>>`, `cat >> ... <<'EOF'`) is routine; a Write, Edit, `>` or copy of
// them, and every other file of Forge's memory and planning stores, asks (AUTO_RUN_RE).
const MEMORY_LOG_RE = /^\.claude\/(?:forge_(?:memory|task_history|agent_ledger|decisions)\.md|agent-memory\/[a-z0-9-]+\/memory\.md)$/;

/** True when `abs` (its real location) is one of those files of THIS project. */
function memoryLog(abs, ctx) {
  if (!abs || isUncPath(abs) || !ctx.realCwd) return false;
  const real = realOf(abs);
  return inside(ctx.realCwd, real) && MEMORY_LOG_RE.test(slashLower(path.relative(ctx.realCwd, real)));
}

/** A command that writes or runs: no gate file, no path outside the project (also through a link), not run from outside it. */
function pathRule(verb, rest, ctx) {
  if (readOnly(verb, rest)) return null;
  if (!ctx.base) return 'unjudgeable';
  if (!writable(ctx, ctx.base)) return 'outside_folder';
  const cmdlet = ctx.isPs && (verb.includes('-') || PS_PATH_ALIASES.has(verb));
  if (HTTP_VERBS.has(verb)) ctx = { ...ctx, http: true };
  // running a hook module (`node .claude/forge-bin/forge-runcontract.cjs plan`) or staging it (`git add`) does not change it
  const script = INTERPRETERS.has(verb) || SCRIPT_RUNNERS.has(verb) ? rest.findIndex((w) => !isOpt(w)) : -1;
  const indexOnly = verb === 'git' && /^(add|stage|commit|notes)$/i.test(gitSub(rest).sub);
  // a copy only reads its sources (a backup of a hook module); its destination is the write
  const copyDest = COPY_VERBS.has(verb) ? rest.reduce((last, w, i) => (isOpt(w) ? last : i), -1) : -1;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (SETTINGS_RE.test(slashLower(w))) return 'settings';
    for (const { text, pathLike } of argTargets(w, k > 0 ? rest[k - 1] : verb, ctx, cmdlet)) { // `-gt $x` alone: the operator is the "verb"
      // `/api/x` is a URL path, `{"a":1}` and `t::npm test` are data: none is a file in the project
      if (!pathLike && (path.isAbsolute(text) || /^[~$%`]/.test(text) || /[\0-\x1f"<>|*?]/.test(text) || /:/.test(text))) continue;
      const abs = locate(text, ctx.base, ctx);
      if (!abs) { if (pathLike) return 'outside_folder'; continue; } // an unknown variable or substitution as the root
      const source = copyDest >= 0 && k !== copyDest && !/^(-destination|--target-directory|-t)$/i.test(k > 0 ? rest[k - 1] : '');
      const g = k !== script && !indexOnly && !source && gateKindAt(abs, ctx);
      // a runner reads the config it is given (`vitest --config vitest.config.js`); whether it may run is the allow-list's call
      if (g && !(g === 'auto_run' && (RUNNER_VERBS.has(verb) || verb === 'node'))) return g;
      if (!writable(ctx, abs)) return 'outside_folder'; // a plain word lands outside only through a link
    }
  }
  // `cp x.cjs .claude/forge-bin/` writes .claude/forge-bin/x.cjs: a copy or move into a folder writes each source's name there
  if (COPY_VERBS.has(verb) || MOVE_VERBS.has(verb)) {
    const args = rest.filter((w) => !isOpt(w));
    const dest = args.length > 1 ? locate(args[args.length - 1], ctx.base, ctx) : null;
    let isDir = false;
    try { isDir = Boolean(dest) && !isUncPath(dest) && fs.statSync(dest).isDirectory(); } catch { /* a new file name */ }
    if (isDir) for (const src of args.slice(0, -1)) { const g = gateKind(path.join(dest, path.basename(src.replace(/[\\/]+$/, ''))), ctx); if (g) return g; }
  }
  return null;
}

/** The working folder after a `cd`-like command (null when it cannot be known). */
function nextBase(words, base, stack, ctx) {
  const vi = findVerb(words);
  if (vi < 0) return base;
  const verb = verbName(words[vi]);
  if (verb === 'popd' || verb === 'pop-location') return stack.length ? stack.pop() : null;
  if (!CD_VERBS.has(verb)) return base;
  if (verb === 'pushd' || verb === 'push-location') stack.push(base);
  const args = words.slice(vi + 1).filter((w) => !/^-(path|literalpath|l|p)$/i.test(w) && !/^-[A-Za-z]$/.test(w));
  if (args.length === 0) return ctx.home;
  if (args[0] === '-' || isDynamic(args[0]) && !/^(?:\$env:\w+|\$\{?\w+\}?|%\w+%)(?:$|[\\/])/i.test(args[0])) return null;
  return locate(args[0], base, ctx);
}
