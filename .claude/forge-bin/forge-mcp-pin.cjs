#!/usr/bin/env node
'use strict';
/**
 * forge-mcp-pin.cjs — supply-chain PIN-CHECK for MCP server launch references.
 *
 * WHY: every upstream MCP install line floats — a bare package name, a moving dist-tag, an `npx -y` with no
 * version, a mutable container tag. Whatever the registry resolves at launch time then runs with the agent's
 * own privileges, so one compromised publish becomes code execution on the owner's machine. This module proves,
 * from the text alone, whether a launch reference is pinned; forge-mcp-gate.cjs refuses a grant when it is not.
 *
 * It NEVER installs, downloads, runs or contacts anything: pure string classification (fs only for the CLI).
 *
 * RISK LEVELS
 *   SAFE       exact version, full 40-char git commit sha, or container image @sha256 digest
 *   MEDIUM     a version range (^ ~ >= < * x, a partial version such as 1.2) — reported, never SAFE
 *   REVIEW     the text cannot settle it: a local path or editable install, and (host files only) an unknown binary,
 *              a script, a shell wrapper, an empty command or a server with neither command nor url. A person must
 *              look; a grant is refused until then. A provably mutable reference stays HIGH, which outranks REVIEW.
 *   HIGH       bare name, dist-tag (latest/next/beta/...), unversioned launcher, opaque shell call, remote URL,
 *              unparseable spec, or a container image without a digest (tags are mutable)
 *   UNVERIFIED a registry entry that honestly states pin:"UNVERIFIED" (no exact version was verified)
 * HIGH, UNVERIFIED and REVIEW BLOCK a grant. An unknown option is read as a boolean switch, so an unknown value-taking
 * option makes its value look like the package: the check then fails CLOSED (HIGH), never open.
 *
 * API
 *   classifyLaunch(command, args)  -> { risk, launcher, refs:[{launcher, spec, risk, reason, version}] }
 *   classifyCommandLine(line)      -> the same, from one quote-aware command line
 *   scanText(text, {tags, launchers}) -> refs found in free text (install hints, notes) + floating "latest" tags
 *   classifyEntry(entry)           -> { id, pin, risk, blocking, refs, reason } (what validateGrant consumes)
 *   checkRegistry(registry, {rawText}) -> { ok, entries, violations } (strict rules for the SHIPPED registry)
 *   scanHostConfig(cfg)            -> { ok, servers, boundary } for an MCP host file ({ mcpServers: { id: {command,args} } })
 *   BOUNDARY                       -> the one-line footer every text report ends with (what this check does not prove)
 * CLI
 *   node forge-mcp-pin.cjs check [--registry <path>] [--json]      0 ok · 3 violations · 2 usage/config error
 *   node forge-mcp-pin.cjs classify <command> [args...] [--json]   0 SAFE/MEDIUM/REVIEW/not-a-launcher · 3 HIGH
 *   node forge-mcp-pin.cjs scan-config <file> [--json]             0 no HIGH · 3 any HIGH · 2 unreadable
 * Exit 3 means "something provably floats"; REVIEW is printed (and refused by the grant gate) but does not set it.
 *
 * PROVENANCE (W2-MCPPIN): the REVIEW class, the explicit "a digest pins even when a tag is present"
 * rule and the boundary footer are ideas taken from ECC skill mcp-dependency-review (affaan-m/ECC,
 * .agents/skills/mcp-dependency-review, MIT). Idea only: no text or code was copied. Deliberate difference: the
 * source sends every VCS reference to REVIEW; here a git source pinned to a full 40-hex commit sha stays SAFE
 * (git content-addresses it) and an unpinned git source or URL stays HIGH (provably movable).
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'mcp-registry.json');
const RISKS = ['NONE', 'SAFE', 'MEDIUM', 'REVIEW', 'UNVERIFIED', 'HIGH'];
const RANK = Object.fromEntries(RISKS.map((r, i) => [r, i]));
const BLOCKING = new Set(['HIGH', 'UNVERIFIED', 'REVIEW']);
const BOUNDARY = 'Boundary: a static text check only - no server was run or installed; SAFE covers the direct pin, not its dependencies or what the server does; a floating reference is a review signal, not proof of compromise.';
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

const SHA40 = /^[0-9a-f]{40}$/i;
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/i;
const EXACT_SEMVER = /^[=v]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PY_EXACT = /^\d+(?:\.\d+)*(?:(?:a|b|rc|\.post|\.dev)\d+)*$/i;
const DIST_TAG = /^[A-Za-z][\w.-]*$/;
const LOCAL_PATH = /^(?:\.{1,2}[\\/]|[\\/]|~|file:|[A-Za-z]:[\\/])/;
const FLOATING_TAG_G = /[@:]latest\b/gi;

function mkRef(launcher, spec, risk, reason, version) {
  return { launcher, spec: spec == null || spec === true ? null : String(spec), risk, reason, version: version || null };
}

// ---- spec classifiers ---------------------------------------------------------------------------------------
function classifyNpmSpec(launcher, raw) {
  if (raw == null || raw === '' || raw === true) return mkRef(launcher, null, 'HIGH', 'no package spec found — cannot prove what would run');
  const spec = String(raw).replace(/^npm:/i, '');
  if (LOCAL_PATH.test(spec)) return mkRef(launcher, spec, 'REVIEW', 'local path — not a registry pin and not content-addressed; review what it holds');
  const gitShorthand = !spec.startsWith('@') && /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec);
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec) || gitShorthand) {
    const hash = spec.includes('#') ? spec.slice(spec.indexOf('#') + 1) : '';
    return SHA40.test(hash)
      ? mkRef(launcher, spec, 'SAFE', 'git source pinned to a full commit sha', hash.toLowerCase())
      : mkRef(launcher, spec, 'HIGH', 'git source without a full 40-character commit sha — the branch or tag can move');
  }
  if (/^https?:\/\//i.test(spec)) return mkRef(launcher, spec, 'HIGH', 'remote URL or tarball — the content behind a URL can change');
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  if (at === -1) return mkRef(launcher, spec, 'HIGH', 'bare package name — resolves to whatever is newest at launch time');
  const v = spec.slice(at + 1);
  if (!v) return mkRef(launcher, spec, 'HIGH', 'empty version after "@"');
  if (EXACT_SEMVER.test(v)) return mkRef(launcher, spec, 'SAFE', 'exact version', v.replace(/^[=v]/, ''));
  if (/[\^~<>*|\s]/.test(v) || /(?:^|\.)[xX*](?:\.|$)/.test(v) || /^\d+(?:\.\d+)?$/.test(v)) {
    return mkRef(launcher, spec, 'MEDIUM', 'version range "' + v + '" — a newer matching release would run without review');
  }
  if (DIST_TAG.test(v)) return mkRef(launcher, spec, 'HIGH', 'dist-tag "' + v + '" is mutable — it moves with every publish');
  return mkRef(launcher, spec, 'HIGH', 'unrecognised version "' + v + '" — refusing rather than guessing');
}

function classifyPySpec(launcher, raw) {
  if (raw == null || raw === '' || raw === true) return mkRef(launcher, null, 'HIGH', 'no package spec found — cannot prove what would run');
  const spec = String(raw).trim();
  if (/^git\+/i.test(spec) || /@\s*git\+/i.test(spec)) {
    const m = /@([0-9a-f]{40})(?:#.*)?$/i.exec(spec);
    return m
      ? mkRef(launcher, spec, 'SAFE', 'git source pinned to a full commit sha', m[1].toLowerCase())
      : mkRef(launcher, spec, 'HIGH', 'git source without a full 40-character commit sha — the branch or tag can move');
  }
  if (/^https?:\/\//i.test(spec)) return mkRef(launcher, spec, 'HIGH', 'remote URL — the content behind a URL can change');
  if (LOCAL_PATH.test(spec)) return mkRef(launcher, spec, 'REVIEW', 'local path — not a registry pin and not content-addressed; review what it holds');
  const s = spec.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  let m = /^[A-Za-z0-9][\w.-]*===?([^,;*]+)$/.exec(s);
  if (m && PY_EXACT.test(m[1])) return mkRef(launcher, spec, 'SAFE', 'exact version', m[1]);
  m = /^[A-Za-z0-9][\w.-]*@(.+)$/.exec(s);
  if (m) {
    if (PY_EXACT.test(m[1])) return mkRef(launcher, spec, 'SAFE', 'exact version', m[1]);
    if (DIST_TAG.test(m[1])) return mkRef(launcher, spec, 'HIGH', 'tag "' + m[1] + '" is mutable — it moves with every release');
    return mkRef(launcher, spec, 'HIGH', 'unrecognised version "' + m[1] + '" — refusing rather than guessing');
  }
  if (/[<>!~=,*]/.test(s)) return mkRef(launcher, spec, 'MEDIUM', 'version range "' + s + '" — a newer matching release would run without review');
  if (/^[A-Za-z0-9][\w.-]*$/.test(s)) return mkRef(launcher, spec, 'HIGH', 'bare package name — resolves to whatever is newest at launch time');
  return mkRef(launcher, spec, 'HIGH', 'unrecognised spec — refusing rather than guessing');
}

function classifyImage(launcher, image) {
  if (image == null || image === '' || image === true) return mkRef(launcher, null, 'HIGH', 'no image found — cannot prove what would run');
  const img = String(image);
  if (IMAGE_DIGEST.test(img)) return mkRef(launcher, img, 'SAFE', 'image pinned by sha256 digest', img.slice(img.lastIndexOf('@') + 1).toLowerCase());
  const last = img.split('/').pop();
  const i = last.indexOf(':');
  const tag = i === -1 ? '' : last.slice(i + 1);
  if (!tag) return mkRef(launcher, img, 'HIGH', 'image without a tag or digest — it floats to whatever is newest');
  return mkRef(launcher, img, 'HIGH', 'image tag "' + tag + '" is mutable — pin the image by its @sha256 digest');
}

// ---- argument parsing ---------------------------------------------------------------------------------------
/** walkOptions(tokens, valueFlags) -> { flags: Map<name, values[]>, positional } — options up to the first
 *  positional (or the token after a bare "--"). Both `--name=value` and `-n value` are understood. */
function walkOptions(tokens, valueFlags) {
  const flags = new Map();
  const put = (k, v) => { if (!flags.has(k)) flags.set(k, []); flags.get(k).push(v); };
  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i]);
    if (t === '--') return { flags, positional: tokens[i + 1] != null ? String(tokens[i + 1]) : null };
    if (t.length > 1 && t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (t.startsWith('--') && eq > 2) { put(t.slice(0, eq), t.slice(eq + 1)); continue; }
      if (valueFlags.has(t)) { put(t, tokens[i + 1] != null ? String(tokens[i + 1]) : ''); i++; continue; }
      put(t, true);
      continue;
    }
    return { flags, positional: t };
  }
  return { flags, positional: null };
}
const valuesOf = (w, names) => names.reduce((acc, n) => acc.concat(w.flags.get(n) || []), []);

const NPX_VALUE = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '-w', '--workspace', '--prefix', '--loglevel']);
const BUNX_VALUE = new Set(['-p', '--package', '--cwd', '--registry']);
const PNPM_VALUE = new Set(['--package', '--reporter', '--dir', '-C', '--filter', '-F', '--allow-build']);
const YARN_VALUE = new Set(['-p', '--package']);
const UVX_VALUE = new Set(['--from', '--with', '-w', '--with-editable', '--with-requirements', '--python', '-p', '--index',
  '--index-url', '--extra-index-url', '--default-index', '--find-links', '-f', '--constraint', '--directory', '--project',
  '--config-file', '--cache-dir', '--env-file', '--refresh-package', '--reinstall-package', '--upgrade-package', '-P',
  '--exclude-newer', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--link-mode', '--color',
  '--allow-insecure-host', '--python-preference']);
const PIPX_VALUE = new Set(['--spec', '--python', '--pip-args', '--index-url', '-i', '--backend', '--fetch-python']);
const DOCKER_VALUE = new Set(['-e', '--env', '--env-file', '-v', '--volume', '-p', '--publish', '--name', '--network', '--net',
  '--entrypoint', '-w', '--workdir', '-u', '--user', '--mount', '--platform', '--pull', '-l', '--label', '-m', '--memory',
  '--cpus', '--add-host', '--cap-add', '--cap-drop', '--device', '--security-opt', '--tmpfs', '--ulimit', '-h', '--hostname',
  '--restart', '--log-driver', '--log-opt', '--dns', '--ipc', '--pid', '--userns', '--gpus', '--shm-size', '--stop-signal']);
const DENO_VALUE = new Set(['--config', '-c', '--import-map', '--cert', '--location', '--seed', '--ext']);

function npmLike(launcher, rest, valueFlags, pkgFlags, shellFlags) {
  const w = walkOptions(rest, valueFlags);
  const refs = [];
  for (const f of shellFlags) {
    if (w.flags.has(f)) refs.push(mkRef(launcher, w.flags.get(f)[0], 'HIGH', 'opaque shell command (' + f + ') — what it runs cannot be pinned from this line'));
  }
  const pkgs = valuesOf(w, pkgFlags);
  if (pkgs.length) pkgs.forEach((p) => refs.push(classifyNpmSpec(launcher, p)));
  else if (!refs.length || w.positional != null) refs.push(classifyNpmSpec(launcher, w.positional));
  return refs;
}
function uvxLike(launcher, rest) {
  const w = walkOptions(rest, UVX_VALUE);
  const refs = [];
  const from = valuesOf(w, ['--from']);
  if (from.length) from.forEach((v) => refs.push(classifyPySpec(launcher, v)));
  else refs.push(classifyPySpec(launcher, w.positional));
  for (const v of valuesOf(w, ['--with', '-w'])) {
    const parts = /[<>=!~]/.test(String(v)) ? [v] : String(v).split(',');
    parts.forEach((one) => refs.push(Object.assign(classifyPySpec(launcher, one), { role: 'extra dependency' })));
  }
  valuesOf(w, ['--with-requirements']).forEach((v) => refs.push(mkRef(launcher, v, 'HIGH', 'requirements file — its pins cannot be proven from this line')));
  valuesOf(w, ['--with-editable']).forEach((v) => refs.push(mkRef(launcher, v, 'REVIEW', 'editable local path — not a registry pin; review what it holds')));
  return refs;
}
function pipxLike(launcher, rest) {
  const w = walkOptions(rest, PIPX_VALUE);
  const spec = valuesOf(w, ['--spec']);
  return spec.length ? spec.map((v) => classifyPySpec(launcher, v)) : [classifyPySpec(launcher, w.positional)];
}
function denoLike(launcher, rest) {
  const w = walkOptions(rest, DENO_VALUE);
  const spec = w.positional;
  if (spec && /^npm:/i.test(spec)) return [classifyNpmSpec(launcher, spec)];
  if (spec && /^jsr:/i.test(spec)) return [classifyNpmSpec(launcher, spec.replace(/^jsr:/i, ''))];
  if (spec && /^https?:\/\//i.test(spec)) return [mkRef(launcher, spec, 'HIGH', 'remote module URL — the content behind a URL can change')];
  if (spec && LOCAL_PATH.test(spec)) return [mkRef(launcher, spec, 'REVIEW', 'local module path — not a registry pin; review what it holds')];
  return [mkRef(launcher, spec, 'HIGH', 'no pinnable module spec found — cannot prove what would run')];
}
function dockerLike(launcher, rest) {
  return [classifyImage(launcher, walkOptions(rest, DOCKER_VALUE).positional)];
}

function cmdBase(tok) {
  return path.basename(String(tok == null ? '' : tok)).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '');
}
/** detectLauncher(tokens) -> { launcher, rest } | null. Unwraps the Windows `cmd /c ...` host-config wrapper. */
function detectLauncher(tokens) {
  let t = (tokens || []).filter((x) => x != null).map(String);
  if (t.length && cmdBase(t[0]) === 'cmd') {
    const k = t.findIndex((x, i) => i > 0 && /^\/[ck]$/i.test(x));
    if (k > 0) t = t.slice(k + 1);
  }
  const a = cmdBase(t[0]);
  const b = (t[1] || '').toLowerCase();
  const c = (t[2] || '').toLowerCase();
  if (a === 'npx') return { launcher: 'npx', rest: t.slice(1) };
  if (a === 'npm' && (b === 'exec' || b === 'x')) return { launcher: 'npm exec', rest: t.slice(2) };
  if (a === 'bunx') return { launcher: 'bunx', rest: t.slice(1) };
  if (a === 'bun' && b === 'x') return { launcher: 'bunx', rest: t.slice(2) };
  if (a === 'pnpx') return { launcher: 'pnpm dlx', rest: t.slice(1) };
  if (a === 'pnpm') {
    const k = t.findIndex((x, i) => i > 0 && x.toLowerCase() === 'dlx');
    return k > 0 ? { launcher: 'pnpm dlx', rest: t.slice(1, k).concat(t.slice(k + 1)) } : null;
  }
  if (a === 'yarn' && b === 'dlx') return { launcher: 'yarn dlx', rest: t.slice(2) };
  if (a === 'uvx') return { launcher: 'uvx', rest: t.slice(1) };
  if (a === 'uv' && b === 'tool' && c === 'run') return { launcher: 'uvx', rest: t.slice(3) };
  if (a === 'pipx' && b === 'run') return { launcher: 'pipx run', rest: t.slice(2) };
  if (a === 'docker' || a === 'podman' || a === 'nerdctl') {
    if (b === 'run') return { launcher: a + ' run', rest: t.slice(2) };
    if (b === 'container' && c === 'run') return { launcher: a + ' run', rest: t.slice(3) };
    return null;
  }
  if (a === 'deno' && b === 'run') return { launcher: 'deno run', rest: t.slice(2) };
  return null;
}

function classifyLaunch(command, args) {
  const d = detectLauncher([command].concat(Array.isArray(args) ? args : []));
  if (!d) return { risk: 'NONE', launcher: null, refs: [] };
  let refs;
  if (d.launcher === 'npx' || d.launcher === 'npm exec') refs = npmLike(d.launcher, d.rest, NPX_VALUE, ['-p', '--package'], ['-c', '--call']);
  else if (d.launcher === 'bunx') refs = npmLike(d.launcher, d.rest, BUNX_VALUE, ['-p', '--package'], []);
  else if (d.launcher === 'pnpm dlx') refs = npmLike(d.launcher, d.rest, PNPM_VALUE, ['--package'], ['-c', '--shell-mode']);
  else if (d.launcher === 'yarn dlx') refs = npmLike(d.launcher, d.rest, YARN_VALUE, ['-p', '--package'], []);
  else if (d.launcher === 'uvx') refs = uvxLike(d.launcher, d.rest);
  else if (d.launcher === 'pipx run') refs = pipxLike(d.launcher, d.rest);
  else if (d.launcher === 'deno run') refs = denoLike(d.launcher, d.rest);
  else refs = dockerLike(d.launcher, d.rest);
  return { risk: refs.reduce((r, x) => worst(r, x.risk), 'NONE'), launcher: d.launcher, refs };
}

function tokenizeLine(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || ''))) !== null) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}
function classifyCommandLine(line) {
  const t = tokenizeLine(line);
  return classifyLaunch(t[0], t.slice(1));
}

// ---- free text, entries, registry, host config --------------------------------------------------------------
const TEXT_STOP = /^(?:—|–|->|=>|;|\||&&|\|\||see|then|or|and)$/i;
/** scanText(text, {tags, launchers}) — floating "latest" tags anywhere (tags, default on) plus launcher
 *  references in prose such as an install hint (launchers, default on). JSON-ish keys ("args:") are skipped. */
function scanText(text, opts) {
  const o = opts || {};
  const s = String(text == null ? '' : text);
  const refs = [];
  if (o.tags !== false) {
    const re = new RegExp(FLOATING_TAG_G.source, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) {
      refs.push(mkRef('text', s.slice(Math.max(0, m.index - 40), m.index + m[0].length).replace(/\s+/g, ' '), 'HIGH', 'floating "' + m[0] + '" tag — it moves with every publish'));
    }
  }
  if (o.launchers === false) return refs;
  const tokens = s.split(/[\s[\]{}(),'"`]+/).filter((x) => x && !/:$/.test(x)).map((x) => x.replace(/[.;]+$/, '')).filter(Boolean);
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const seg = [tokens[i]];
    for (let j = i + 1; j < tokens.length && seg.length < 40 && !TEXT_STOP.test(tokens[j]); j++) seg.push(tokens[j]);
    if (!detectLauncher(seg)) continue;
    for (const x of classifyLaunch(seg[0], seg.slice(1)).refs) {
      const key = x.launcher + '|' + x.spec + '|' + x.risk;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(Object.assign({}, x, { source: 'text' }));
    }
  }
  return refs;
}

function collectStrings(v, out, skipKeys) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out, null));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (!(skipKeys && skipKeys.has(k))) collectStrings(x, out, null);
  }
  return out;
}

/** classifyEntry(entry) — one registry entry. The structured `launch` is classified exactly; every other string
 *  is scanned for launcher references; the whole entry (keys too) is scanned for floating tags. A real `pin` must
 *  equal the exact version a SAFE launch reference carries; pin "UNVERIFIED" is honest but blocking. */
function classifyEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const refs = [];
  if (e.launch != null) {
    const l = e.launch;
    if (typeof l !== 'object' || Array.isArray(l) || typeof l.command !== 'string') {
      refs.push(mkRef('launch', null, 'HIGH', 'launch must be null or {command, args[, env]} — refusing a launch spec it cannot read'));
    } else {
      const r = classifyLaunch(l.command, Array.isArray(l.args) ? l.args : []);
      if (!r.refs.length) refs.push(mkRef('launch', l.command, 'HIGH', 'launch command "' + l.command + '" is not a recognised pinnable launcher — cannot prove what would run'));
      r.refs.forEach((x) => refs.push(Object.assign({}, x, { source: 'launch' })));
    }
  }
  scanText(JSON.stringify(e), { launchers: false }).forEach((x) => refs.push(x));
  for (const s of collectStrings(e, [], new Set(['launch']))) scanText(s, { tags: false }).forEach((x) => refs.push(x));
  const pin = typeof e.pin === 'string' && e.pin.trim() ? e.pin.trim() : null;
  let risk = 'NONE';
  if (pin === 'UNVERIFIED') risk = 'UNVERIFIED';
  else if (!pin) refs.push(mkRef('pin', null, 'HIGH', 'no pin recorded — nothing proves which version would run'));
  else {
    const fromLaunch = refs.filter((x) => x.source === 'launch');
    if (!fromLaunch.length) refs.push(mkRef('pin', pin, 'HIGH', 'pin "' + pin + '" is recorded but no launch reference carries it'));
    else if (!fromLaunch.some((x) => x.risk === 'SAFE' && x.version === pin)) {
      refs.push(mkRef('pin', pin, 'HIGH', 'pin "' + pin + '" does not match the exact version in launch (' + fromLaunch.map((x) => x.spec).join(', ') + ')'));
    }
  }
  for (const x of refs) risk = worst(risk, x.risk);
  const bad = refs.filter((x) => RANK[x.risk] >= RANK.MEDIUM);
  const reason = bad.length
    ? bad.map((x) => x.risk + ': ' + (x.spec ? x.spec + ' — ' : '') + x.reason).join('; ')
    : (risk === 'UNVERIFIED' ? 'pin is UNVERIFIED — no exact version or digest has been verified for this server' : 'every launch reference is pinned exactly');
  return { id: e.id == null ? null : String(e.id), pin, risk, blocking: BLOCKING.has(risk), refs, reason };
}

/** checkRegistry — the SHIPPED registry's strict rules: no floating tag anywhere (keys, prose, docs), every entry
 *  `enabled:false`, every entry SAFE (a sourced, exact pin) or explicitly UNVERIFIED with no runnable launch. */
function checkRegistry(registry, opts) {
  const o = opts || {};
  const violations = [];
  const add = (id, rule, detail) => violations.push({ id: id == null ? null : String(id), rule, detail });
  // The floating-tag scan runs FIRST and over the raw text, so it is reported even when the shape is broken
  // (a renamed "servers" key must surface both problems, never only the first one found).
  const raw = typeof o.rawText === 'string' ? o.rawText : JSON.stringify(registry);
  const re = new RegExp(FLOATING_TAG_G.source, 'gi');
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    add(null, 'floating-tag', 'the registry text contains "' + m[0] + '" near "' + String(raw).slice(Math.max(0, m.index - 30), m.index + m[0].length).replace(/\s+/g, ' ') + '" — a floating tag is refused anywhere in the registry');
  }
  if (!registry || !Array.isArray(registry.servers)) {
    add(null, 'shape', 'registry has no "servers" array');
    return { ok: false, entries: [], violations };
  }
  const entries = [];
  const seen = new Set();
  for (const s of registry.servers) {
    const id = s && s.id;
    if (seen.has(id)) add(id, 'duplicate-id', 'server id appears more than once');
    seen.add(id);
    const c = classifyEntry(s);
    entries.push({ id: c.id, pin: c.pin, risk: c.risk, blocking: c.blocking, reason: c.reason });
    if (!s || s.enabled !== false) {
      add(id, 'not-dormant', '"enabled" must be exactly false in the shipped registry (found ' + JSON.stringify(s && s.enabled) + ') — the owner-authored opt-in file is the only activation channel');
    }
    if (c.risk === 'UNVERIFIED') {
      if (s.launch != null) add(id, 'unverified-with-launch', 'an UNVERIFIED entry must not ship a runnable launch command');
    } else if (c.risk !== 'SAFE') {
      add(id, 'pin-' + c.risk.toLowerCase(), c.reason);
    } else {
      const v = s.verification;
      const sourced = v && typeof v.date === 'string' && Array.isArray(v.sources) && v.sources.length > 0
        && v.sources.every((u) => /^https:\/\//.test(String(u)));
      if (!sourced) add(id, 'unsourced-pin', 'a verified pin must record verification.date and https verification.sources');
    }
  }
  return { ok: violations.length === 0, entries, violations };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
/** nonLauncherRefs(server) — a host-file server whose command is not a recognised package launcher. Nothing is
 *  omitted: a remote url server is NONE, everything else is REVIEW, and a shell wrapper's inner text is scanned too
 *  so a floating launcher hidden inside "bash -c ..." still comes out HIGH. */
function nonLauncherRefs(s) {
  const args = Array.isArray(s.args) ? s.args.map(String) : [];
  if (s.command == null) {
    return typeof s.url === 'string' && s.url ? [] : [mkRef('host', null, 'REVIEW', 'server has neither a command nor a url — cannot tell what it runs')];
  }
  if (typeof s.command !== 'string' || !s.command.trim()) return [mkRef('host', null, 'REVIEW', 'empty or unreadable command — cannot tell what it runs')];
  const base = cmdBase(s.command);
  if (SHELLS.has(base)) {
    return [mkRef('host', s.command, 'REVIEW', 'shell wrapper — what it runs cannot be pinned from this line')]
      .concat(scanText(args.join(' '), { tags: false }));
  }
  return [mkRef('host', s.command, 'REVIEW', 'not a package launcher (a local binary or script) — no pin can be proven; review what it runs')];
}

/** scanHostConfig(cfg) — classify every server in an MCP host file (.mcp.json shape). */
function scanHostConfig(cfg) {
  const servers = [];
  const map = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  for (const [id, s] of Object.entries(map)) {
    if (!s || typeof s !== 'object') { servers.push({ id, risk: 'HIGH', refs: [], reason: 'server entry is not an object' }); continue; }
    const tags = scanText(JSON.stringify(s), { launchers: false });
    const r = typeof s.command === 'string' ? classifyLaunch(s.command, Array.isArray(s.args) ? s.args : []) : { risk: 'NONE', launcher: null, refs: [] };
    const refs = r.refs.concat(r.launcher ? [] : nonLauncherRefs(s), tags);
    const risk = refs.reduce((acc, x) => worst(acc, x.risk), 'NONE');
    const bad = refs.filter((x) => RANK[x.risk] >= RANK.MEDIUM);
    const reason = bad.length ? bad.map((x) => x.risk + ': ' + (x.spec ? x.spec + ' — ' : '') + x.reason).join('; ')
      : (r.launcher ? 'pinned exactly' : (s.url ? 'remote server URL — no local package to pin' : 'not a package launcher — nothing to pin'));
    servers.push({ id, risk, launcher: r.launcher, refs, reason });
  }
  return { ok: servers.every((x) => x.risk !== 'HIGH'), servers, boundary: BOUNDARY };
}

module.exports = {
  classifyLaunch, classifyCommandLine, classifyNpmSpec, classifyPySpec, classifyImage, detectLauncher,
  scanText, classifyEntry, checkRegistry, scanHostConfig, tokenizeLine,
  RISKS, BLOCKING, BOUNDARY, REGISTRY_PATH,
};

// ---- CLI ----------------------------------------------------------------------------------------------------
function usage() {
  console.error('Usage: node forge-mcp-pin.cjs check [--registry <path>] [--json]');
  console.error('       node forge-mcp-pin.cjs classify <command> [args...] [--json]');
  console.error('       node forge-mcp-pin.cjs scan-config <file> [--json]');
  return 2;
}
function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return { raw, data: JSON.parse(raw) };
}
function main(argv) {
  const cmd = argv[0];
  const json = argv.includes('--json');
  const rest = argv.slice(1).filter((a) => a !== '--json');
  if (cmd === 'check') {
    const k = rest.indexOf('--registry');
    const p = k === -1 ? REGISTRY_PATH : rest[k + 1];
    if (!p) return usage();
    let f;
    try { f = readJson(p); } catch (e) { console.error('forge-mcp-pin: cannot read ' + p + ': ' + e.message); return 2; }
    const r = checkRegistry(f.data, { rawText: f.raw });
    if (json) console.log(JSON.stringify(r));
    else {
      for (const e of r.entries) console.log(e.id + '\t' + e.risk + '\tpin=' + e.pin + (e.risk === 'SAFE' ? '' : '\t' + e.reason));
      for (const v of r.violations) console.log('VIOLATION ' + (v.id || '(registry)') + ' [' + v.rule + '] ' + v.detail);
      const n = (risk) => r.entries.filter((e) => e.risk === risk).length;
      console.log(r.ok
        ? 'PIN-CHECK OK: ' + r.entries.length + ' entries — ' + n('SAFE') + ' SAFE (exact, sourced pin), ' + n('UNVERIFIED') + ' UNVERIFIED (every grant on these is refused until a verified pin is recorded)'
        : 'PIN-CHECK FAILED: ' + r.violations.length + ' violation(s)');
      console.log(BOUNDARY);
    }
    return r.ok ? 0 : 3;
  }
  if (cmd === 'classify') {
    if (!rest.length) return usage();
    const r = classifyLaunch(rest[0], rest.slice(1));
    if (json) console.log(JSON.stringify(r));
    else if (!r.launcher) console.log('NONE — "' + rest[0] + '" is not a package launcher (nothing to pin)');
    else for (const x of r.refs) console.log(x.risk + '\t' + x.launcher + '\t' + (x.spec || '(none)') + '\t' + x.reason);
    return r.risk === 'HIGH' ? 3 : 0;
  }
  if (cmd === 'scan-config') {
    if (!rest[0]) return usage();
    let f;
    try { f = readJson(rest[0]); } catch (e) { console.error('forge-mcp-pin: cannot read ' + rest[0] + ': ' + e.message); return 2; }
    const r = scanHostConfig(f.data);
    if (json) console.log(JSON.stringify(r));
    else {
      for (const s of r.servers) console.log(s.id + '\t' + s.risk + '\t' + s.reason);
      console.log(BOUNDARY);
    }
    return r.ok ? 0 : 3;
  }
  return usage();
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
