'use strict';
/**
 * forge-gate-cannot-judge.cjs — the CANNOT-JUDGE keyword scan of the PreToolUse gate hook (forge-gate-hook.cjs). Split
 * out of the hook in FU-A7 (review medium: the hook had grown past 800
 * lines). The move itself changed no behaviour (the hook's own suite ran green on the moved copy before anything else
 * changed); the keyword list was widened afterwards (see RISKY_ATOMS).
 *
 * What it answers: which hard-gate KEYWORDS does a command text show? Nothing else. It never decides, never reads
 * config, never writes. The hook asks it only for a call it cannot judge (unparseable or oversized stdin, a stdin that
 * breaks off, an internal error, a classifier that cannot run): a keyword then turns the old non-blocking exit 1 into a
 * refusal (exit 2, gate id cannot-judge-risky); no keyword keeps the visible exit 1 (forge-gate-hook.cjs
 * cannotJudgeResult). A call the hook CAN judge never reaches this module.
 *
 * The keywords are the eight command gates (global-input-command added W1) plus the gate's own self-disable, read as plain WORDS: at least as broad as
 * the real classifier (which is exactly what cannot run here; the test pins it on every hard-gates.json example), so a
 * command a healthy hook allows (git checkout main) is refused too while the hook is broken. That is the price of
 * failing closed; a healthy hook never gets here.
 * Every atom is LINEAR on any input: a literal word with a one- or two-character boundary look, a fixed word chain, or
 * a bounded class after a literal; never an unbounded class before a literal (the shape sec-v1r-H1 proved
 * catastrophic). The left boundary also accepts a JSON escape (\n \r \t \b \f): the stdin paths read raw JSON, where
 * `echo hi\nrm -rf x` arrives as the characters `\` `n` `r` `m`. Over-reporting is the safe direction here.
 *
 * EXPORTS: RISKY_ATOMS · RISKY_SIGNALS · RISKY_OVERLAP_CHARS · VIEW_MAX_CHARS · createRiskScanner() · riskySignals(text)
 * · rawCommandText(raw) · cannotJudgeView(command, shell, maxChars). Zero dependencies beyond Node core
 * (string_decoder); forge-gate-data.cjs (the inert-data rule) is read lazily and is optional.
 */
const { StringDecoder } = require('string_decoder');

const RISKY_LEFT = String.raw`(?:(?<![\w-])|(?<=\\[nrtbf]))`;
const riskyWord = (alts) => new RegExp(RISKY_LEFT + '(?:' + alts + ')(?![\\w-])', 'i');
// FU-A7 (Security Boss medium): the first list was NARROWER than the classifier for several shapes (kill after a
// pipe, $_.Kill(), wmic; a path-qualified pipe shell, `sh -c "$x"`, `<(`, `<<<`; service-account and .docker/config.json,
// `prod.env`, a hyphen before a secret name; and, found by the drift canary in the test, .Delete(), a flag before
// `plugin`, interpreter writes and copies into .claude/). Each family below was traced against hard-gates.json, the
// classifier's -c policy and its glob/brace secret view, and widened to at least the classifier's reach; the test asserts
// it for every examples.match shape of every command gate, plus the shapes a differential run of the classifier against
// this scan found. Where the classifier reads one long run (`[\w.-]*credentials[\w.-]*\.json`), the scan reads two words
// anywhere instead (credentials + .json): broader, and linear without a bound.
const SHELLS = 'sh|bash|zsh|dash|ksh|fish|powershell|pwsh|cmd';
const RISKY_ATOMS = {
  delete: riskyWord('rm|rmdir|rd|del|erase|ri|rimraf|Remove-Item|-delete'),
  dotDelete: /\.delete\s*\(/i,
  killName: riskyWord('taskkill|tskill|pkill|killall|Stop-Process|spps'),
  // a plain `kill` word: covers `kill $(pgrep x)`, `| xargs kill`, `ps x | kill`, `$_.Kill()` and `kill -Name x`; a
  // `kill <pid>` is refused too while the hook is broken (the same price `Stop-Process -Id` and `taskkill /PID` pay)
  kill: riskyWord('kill'),
  wmic: riskyWord('wmic'),
  wmicKill: riskyWord('delete|terminate'),
  git: riskyWord('git'),
  gitDiscard: riskyWord('reset|clean|checkout|restore|switch|stash|worktree'),
  evalWord: riskyWord('iex|Invoke-Expression|eval'),
  // a pipe, then within 200 characters (no other pipe, newline, `;` or `&` in between) a shell word: `| bash`,
  // `| /bin/bash`, `| /usr/bin/env bash`, `| sudo sh`. The bounded class after the literal `|` keeps it linear.
  pipeShell: new RegExp(String.raw`\|[^|\n;&]{0,200}?` + RISKY_LEFT + '(?:' + SHELLS + String.raw`)(?:\.exe)?(?![\w-])`, 'i'),
  // the classifier's -c policy: a `-c` token with a live `$` or backtick fires whatever command word owns it (su,
  // runuser, flock, csh, "$SHELL", wrappers it cannot resolve), so here a `-c` plus `$`/backtick anywhere counts; an
  // interpreter word with `-c` counts on its own (a cut-off payload can end right after `bash -c "`), as does cmd /c|/k
  shellWord: new RegExp(RISKY_LEFT + '(?:' + SHELLS + String.raw`)(?:\.exe)?(?![\w-])`, 'i'),
  dashC: /(?:^|\s|(?<=\\[nrtbf]))-c(?!\w)/,
  subst: /[$`]/,
  cmdWord: new RegExp(RISKY_LEFT + String.raw`cmd(?:\.exe)?(?![\w-])`, 'i'),
  slashCK: /(?:^|\s|(?<=\\[nrtbf]))\/[ck](?![\w:])/i,
  // `env -S` / `--split-string`: the classifier cannot resolve its operand and fires on it
  envSplit: new RegExp(RISKY_LEFT + String.raw`env\s+(?:-S|--split-string)(?![\w-])`),
  // process substitution / here-string into a shell (`bash <(curl x)`, `bash <<< "$x"`, `source <(x)`) and `. <(x)`
  shellFeed: new RegExp(RISKY_LEFT + '(?:' + SHELLS + String.raw`|source)(?:\.exe)?\s*(?:<\(|<<<)|(?:^|[;&|\n]|\\n)\s*\.\s+<\(`, 'i'),
  psHost: riskyWord('powershell|pwsh'),
  encFlag: riskyWord('-e|-ec|-en|-enc|-enco|-encod|-encode|-encoded|-encodedc|-encodedco|-encodedcom|-encodedcomm|-encodedcomma|-encodedcomman|-encodedcommand'),
  certutil: riskyWord('certutil'),
  decodeFlag: riskyWord('-decode'),
  // the classifier's secret list (forge-actiongate.cjs SECRET_TARGET_RE), its `\b` read as "no word character before /
  // after", so `prod.env`, `my-secrets/`, `backup-id_rsa` and `server.pem-old` count; only `process.env` (and `$.env`)
  // is left out, so `node -e "...process.env..."` carries no keyword
  secretFile: /(?<!\$|process)\.env(?!\w)(?!\.(?:example|sample|template)(?![\w-]))|(?<!\w)id_(?:rsa|ed25519)|\.git-credentials|\.aws[\\/]+credentials|\.docker[\\/]+config\.json|(?<!\w)secrets(?:[\\/]|(?![\w.-]))|\.(?:pem|key|p12|pfx|npmrc|pypirc|netrc)(?!\w)|(?<!\w)forge-accounts(?![\w-])/i,
  credWord: /credentials|service-account/i,
  jsonFile: /\.json(?!\w)/i,
  // the classifier also expands globs and braces that can reach a secret name (`cat .e*`, `grep x id_*`, `cat .{e,x}nv`,
  // `cat ~/.ssh/*`) and fails closed on too many expansions; here a reading verb plus ANY glob/brace character counts
  // (broader: `cat *.md` is refused too while the hook is broken)
  readVerb: riskyWord('cat|type|gc|Get-Content|more|less|head|tail|bat|grep|egrep|fgrep|rg|Select-String|sls|findstr'),
  gitRead: riskyWord('show|log|whatchanged|diff|blame|annotate|cat-file'),
  globChar: /[*?[{]/,
  claudeWord: /(?:(?<![.\w-])|(?<=\\[nrtbf]))claude(?:-code)?(?:\.exe|\.cmd|\.ps1)?(?![\w-])/i,
  pluginVerb: new RegExp(RISKY_LEFT + String.raw`plugins?\s+(?:install|i|enable|update|marketplace\s+add)(?![\w-])`, 'i'),
  configVerb: new RegExp(RISKY_LEFT + String.raw`config\s+(?:set|add|remove)(?![\w-])`, 'i'),
  settingsFile: /\.claude[\\/]+settings/i,
  // a redirect INTO the settings path (the run after `>` stops at the next `>`, so the bounded scan stays linear), or a
  // writer verb anywhere next to a settings mention; a plain read (`cat .claude/settings.json`) is no keyword (WP33B)
  settingsRedirect: />{1,2}\s*(?:\\?["'])?[^\s"'<>|;&()]{0,200}\.claude[\\/]+settings/i,
  // every writer the classifier names for this gate: shell and PowerShell writers, delete/move/copy/link verbs, dd, and
  // the interpreter write APIs of its line_all_of rule (fs.*Sync, Python write_text/shutil/os); `open(` + a write mode
  // is the separate pair openCall + writeMode below
  settingsWriter: new RegExp(RISKY_LEFT + '(?:tee|Tee-Object|Set-Content|sc|Add-Content|ac|Out-File|Clear-Content|clc|New-Item|ni|sponge|truncate'
    + '|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|cp|copy|cpi|xcopy|mv|move|mi|Copy-Item|Move-Item|Rename-Item|rni'
    + '|ren|rename|rm|del|erase|unlink|Remove-Item|ri|sed|perl|ruby|ln|mklink|dd|writeFileSync|writeFile|appendFileSync|appendFile'
    + '|copyFileSync|copyFile|cpSync|renameSync|rmSync|unlinkSync|createWriteStream|write_text|write_bytes|writelines)(?![\\w-])'
    + String.raw`|(?:shutil\.(?:copy\w{0,20}|move)|os\.(?:replace|rename|remove))\s*\(`, 'i'),
  openCall: new RegExp(RISKY_LEFT + String.raw`open\s*\(`, 'i'),
  writeMode: /['"][wax]\+?b?['"]/i,
  // a file NAMED settings(.local).json next to a .claude folder and a writer: `cp ./settings.json .claude/`, and the
  // path.join / string-concatenation form of the classifier (`join(home, '.claude', 'settings.json')`)
  settingsName: /(?<![\w.-])settings(?:\.local)?\.json(?!\w)/i,
  claudeDir: /\.claude(?![\w.-])/i,
  // global keyboard/mouse input, read as plain words (broader than the classifier's code shapes;
  // `SendKeys` is matched inside `.SendKeys(` and `[System.Windows.Forms.SendKeys]` because `.`/`[` is no word char)
  globalInput: new RegExp(String.raw`(?:(?<![\w])|(?<=\\[nrtbf]))(?:SendKeys|SendWait|SendInput|keybd_event|mouse_event|AppActivate)(?!\w)`, 'i'),
  gateHookWord: riskyWord('gate-hook'),
  forgeConfig: /forge-config|(?<![\w-])forge(?:\.cmd|\.ps1|\.sh)?(?![\w-])/i,
};
const RISKY_ATOM_NAMES = Object.keys(RISKY_ATOMS);
// [gate id, atoms that must ALL appear somewhere in the text]
const RISKY_SIGNALS = [
  ['destructive-delete', ['delete']], ['destructive-delete', ['dotDelete']],
  ['kill-by-name', ['killName']], ['kill-by-name', ['kill']], ['kill-by-name', ['wmic', 'wmicKill']],
  ['git-destructive', ['git', 'gitDiscard']],
  ['opaque-exec', ['evalWord']], ['opaque-exec', ['pipeShell']], ['opaque-exec', ['dashC', 'subst']], ['opaque-exec', ['shellWord', 'dashC']],
  ['opaque-exec', ['cmdWord', 'slashCK']], ['opaque-exec', ['envSplit']], ['opaque-exec', ['shellFeed']],
  ['opaque-exec', ['psHost', 'encFlag']], ['opaque-exec', ['certutil', 'decodeFlag']],
  ['secret-print', ['secretFile']], ['secret-print', ['credWord', 'jsonFile']], ['secret-print', ['readVerb', 'globChar']],
  ['secret-print', ['git', 'gitRead', 'globChar']],
  ['plugin-install-command', ['claudeWord', 'pluginVerb']],
  ['settings-edit-command', ['settingsRedirect']], ['settings-edit-command', ['settingsFile', 'settingsWriter']],
  ['settings-edit-command', ['settingsFile', 'openCall', 'writeMode']], ['settings-edit-command', ['settingsName', 'claudeDir', 'settingsWriter']],
  ['settings-edit-command', ['claudeWord', 'configVerb']],
  ['global-input-command', ['globalInput']],
  ['gate-hook-self-disable', ['gateHookWord', 'forgeConfig']],
];
const RISKY_OVERLAP_CHARS = 256;
// the size forge-gate-hook.cjs inspects inline on the main thread (its WATCHDOG_UNAVAILABLE_FALLBACK_CHARS); the hook
// passes its own value, this is only the default for a direct caller
const VIEW_MAX_CHARS = 10000;

/** createRiskScanner() -> { push(chunk), signals() }. Reads text in pieces (a Buffer is decoded as UTF-8 across piece
 *  boundaries) and remembers which atoms it has seen; signals() returns the sorted, unique gate ids whose atoms ALL
 *  appeared, anywhere in the text. Each piece is scanned together with the last RISKY_OVERLAP_CHARS characters before
 *  it, so a keyword split across two pieces is still found. At such a seam a keyword can also be over-reported (the cut
 *  hid its neighbour), and only a match longer than the overlap (a word chain with hundreds of spaces inside) can be
 *  missed. Memory stays one piece plus the overlap. Never throws: a failure inside reports `risk-scan-failed`, which
 *  blocks like a keyword (a call that can neither be judged nor scanned is refused). */
function createRiskScanner() {
  const decoder = new StringDecoder('utf8');
  const seen = new Set();
  let carry = '';
  let failed = false;
  const feed = (piece) => {
    if (!piece) return;
    const win = carry + piece;
    for (const name of RISKY_ATOM_NAMES) if (!seen.has(name) && RISKY_ATOMS[name].test(win)) seen.add(name);
    carry = win.length > RISKY_OVERLAP_CHARS ? win.slice(-RISKY_OVERLAP_CHARS) : win;
  };
  return {
    push(chunk) {
      try { feed(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)); } catch { failed = true; }
    },
    signals() {
      try { feed(decoder.end()); } catch { failed = true; }
      const ids = new Set(RISKY_SIGNALS.filter(([, atoms]) => atoms.every((a) => seen.has(a))).map(([id]) => id));
      if (failed) ids.add('risk-scan-failed');
      return [...ids].sort();
    },
  };
}
/** riskySignals(text) -> the gate ids whose keywords appear in `text` ([] = none). One linear pass per atom. */
function riskySignals(text) {
  const s = createRiskScanner();
  s.push(text === undefined || text === null ? '' : String(text));
  return s.signals();
}

/** rawCommandText(raw) -> for a payload JSON.parse could not read: the text of its first JSON "command" string (escapes
 *  kept as written; a cut-off string runs to the end), or the whole raw text when there is no such key. So the keyword
 *  scan reads the command, not a description that only talks about deleting. Linear. */
const COMMAND_KEY_RE = /"command"\s*:\s*"/;
function rawCommandText(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw);
  const m = COMMAND_KEY_RE.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length;
  let i = start;
  while (i < text.length && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1; // 34 = ", 92 = \
  return text.slice(start, Math.min(i, text.length));
}

/** cannotJudgeView(command, shell, maxChars) -> the text the keyword scan reads for a PARSED command: the command after
 *  the SAME inert-data rule the classifier uses (forge-gate-data.cjs: heredoc bodies into a plain writer, echo/printf
 *  literals, log-event payloads, search patterns), so data that only mentions a gated command carries no keyword. Only
 *  up to maxChars (default VIEW_MAX_CHARS, the size the hook already inspects inline on the main thread); a larger
 *  command, a data module that cannot load, or its segment-count refusal reads the raw text (stricter: never fewer
 *  keywords). */
function cannotJudgeView(command, shell, maxChars) {
  const text = String(command);
  if (text.length > (typeof maxChars === 'number' ? maxChars : VIEW_MAX_CHARS)) return text;
  try {
    const d = require('./forge-gate-data.cjs').stripInertData(text, shell);
    return d && !d.tooManySegments && typeof d.text === 'string' ? d.text : text;
  } catch {
    return text; // the data rule cannot load: read the raw text (stricter)
  }
}

module.exports = {
  RISKY_ATOMS, RISKY_SIGNALS, RISKY_OVERLAP_CHARS, VIEW_MAX_CHARS,
  createRiskScanner, riskySignals, rawCommandText, cannotJudgeView,
};
