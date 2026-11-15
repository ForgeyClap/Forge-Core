#!/usr/bin/env node
'use strict';
/**
 * forge-system-skill.cjs — generates the single-entry `forge-system` skill (owner question R-0235):
 * the whole Forge system as one SKILL.md plus references/*.md, built FROM THE REAL DATA, never from hand-typed lists.
 *
 * OUTPUT (all under <root>/.claude/skills/forge-system/):
 *   SKILL.md                table of contents + operating rules (run contract, GOAT routes, Bosses, lanes, gates,
 *                           scribe, memory, owner queue, resume) and an up-front statement of what a skill cannot do
 *   references/agents.md    config/agents/agent-registry.json + .claude/agents/*.md frontmatter + FORGE_MODEL_ROUTING.json
 *   references/skills.md    every .claude/skills/<name>/SKILL.md name + description, grouped
 *   references/commands.md  .claude/commands/*.md (frontmatter + the /forge sub-command list)
 *   references/hooks.md     hook scripts registered in .claude/settings.json (read only)
 *   references/gates.md     config/orchestration/hard-gates.json (command gates vs owner gates; no raw patterns)
 *   references/config.md    config/orchestration/FORGE_CONFIG_SCHEMA.json keys
 *   references/routes.md    FORGE_MODEL_ROUTING.json routes, agent defaults, escalation
 *   references/tools.md     forge-bin/*.cjs (not tests) with the one-line purpose from each file header
 *   references/workflows.md how a run goes: commands/forge.md build flow, run-checklist.json, workflows/*.js meta
 *   references/limits.md    what a skill cannot enforce, and what still does (hooks, command gates)
 *
 * RULES: reads only inside <root>; every free text is redacted with forge-store's SECRET_PATTERNS; a backticked
 * project path that would not resolve (or points into a local-only folder) is written as plain text, so the
 * doctor's skill_hygiene never sees a dead link; deterministic (no clock, sorted lists); a file is written only
 * when its bytes change; a generated reference whose source is gone is removed with a single-file unlink (never a
 * recursive delete); files without the generated mark (evals.json, hand notes) are never touched.
 *
 * CLI (exit 0 ok · 1 check found problems · 2 usage):
 *   node forge-system-skill.cjs generate [--root <dir>] [--json]
 *   node forge-system-skill.cjs check    [--root <dir>] [--json]    stale vs sources, dead refs, secret patterns
 *   node forge-system-skill.cjs export   --out <dir> [--root <dir>] [--json]   portable copy: SKILL.md + references only
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_NAME = 'forge-system';
const SKILL_REL = '.claude/skills/' + SKILL_NAME;
const GEN_MARK = 'generated: forge-system-skill';
const DESCRIPTION = 'Use when asked what Forge is or how it works end to end (hoe werkt forge, uitleg).';

const store = (() => { try { return require('./forge-store.cjs'); } catch { return null; } })();
const scrubber = (() => { try { return require('./forge-secret-scrub.cjs'); } catch { return null; } })();
const hygiene = (() => { try { return require('./doctor/checks-hygiene.cjs'); } catch { return null; } })();
const FALLBACK_SECRET_RES = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g];
const SECRET_RES = (store && Array.isArray(store.SECRET_PATTERNS) && store.SECRET_PATTERNS.length ? store.SECRET_PATTERNS : FALLBACK_SECRET_RES)
  .map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
const LOCAL_ONLY_RE = (hygiene && hygiene.LOCAL_ONLY_REF_RE) || /^\.claude\/(forge-research|forge-runs)\//;

// ---------- small helpers ----------
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }
function listDirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } }
function listFiles(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort(); } catch { return []; } }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function realEntries(o) { return Object.entries(isObj(o) ? o : {}).filter(([k]) => !k.startsWith('_')); }
function redact(text) { let t = String(text == null ? '' : text); for (const re of SECRET_RES) t = t.replace(re, '[REDACTED]'); return t; }
function oneLine(s, n) { const t = redact(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function cell(s, n) { return oneLine(s, n || 200).replace(/\|/g, '\\|') || '—'; }
function code(s) { return '`' + String(s).replace(/`/g, "'") + '`'; }

function parseFrontmatter(text) {
  const out = {};
  if (!text || !text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  let key = null; let mode = null;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      key = m[1]; const v = m[2].trim();
      if (v === '') { out[key] = []; mode = 'list'; } else if (/^[>|]-?$/.test(v)) { out[key] = ''; mode = 'block'; } else { out[key] = v.replace(/^["']|["']$/g, ''); mode = null; }
      continue;
    }
    if (!key) continue;
    const li = line.match(/^\s*-\s+(.*)$/);
    if (mode === 'list' && li) out[key].push(li[1].trim().replace(/^["']|["']$/g, ''));
    else if (mode === 'block' && line.trim()) out[key] = (out[key] ? out[key] + ' ' : '') + line.trim();
  }
  return out;
}

/** headerPurpose(text, file) -> the one-line purpose from a script's header comment ("<file> — purpose."). */
function headerPurpose(text, file) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 40);
  const strip = (l) => l.replace(/^\s*(?:\/\*\*?|\*\/?|\/\/)\s?/, '').replace(/\*\/\s*$/, '').trim();
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '\\s+[—–-]+\\s+(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = strip(lines[i]).match(re);
    if (!m) continue;
    let s = m[1];
    for (let j = i + 1; j < Math.min(lines.length, i + 3) && !/[.!?]$/.test(s.trim()); j++) {
      const next = strip(lines[j]);
      if (!next || !/^\s*(\*|\/\/)/.test(lines[j])) break;
      s += ' ' + next;
    }
    const cut = s.search(/[.!?](\s|$)/);
    return oneLine(cut >= 0 ? s.slice(0, cut + 1) : s, 220);
  }
  const first = lines.map(strip).find((l) => l && !/^#!|^'use strict'|^"use strict"/.test(l) && /[A-Za-z]{3}/.test(l));
  return first ? oneLine(first, 220) : '(no header comment)';
}

// ---------- collect the real data ----------
function collect(root) {
  const C = path.join(root, '.claude');
  const registry = readJson(path.join(C, 'config/agents/agent-registry.json')) || {};
  const routing = readJson(path.join(C, 'FORGE_MODEL_ROUTING.json')) || {};
  const defaults = Object.fromEntries(realEntries(routing.agentDefaults).filter(([, v]) => typeof v === 'string'));
  const agentFm = {};
  for (const f of listFiles(path.join(C, 'agents')).filter((x) => x.endsWith('.md'))) agentFm[f.replace(/\.md$/, '')] = parseFrontmatter(readText(path.join(C, 'agents', f)) || '');
  const agentRow = (id, reg) => ({ id, name: reg.name || (agentFm[id] && agentFm[id].name) || id, role: reg.role || '', route: defaults[id] || '', fm: agentFm[id] || null, desc: (agentFm[id] && agentFm[id].description) || reg.responsibilities || '' });
  const bosses = realEntries(registry.agents).map(([id, reg]) => agentRow(id, reg || {}));
  const specialists = realEntries(registry.specialistAgents).map(([id, reg]) => agentRow(id, reg || {}));
  const known = new Set([...bosses, ...specialists].map((a) => a.id));
  const unregistered = Object.keys(agentFm).filter((id) => !known.has(id)).sort().map((id) => agentRow(id, {}));

  // This skill lists itself from its own constant, never from its own (possibly stale) file: keeps generate idempotent.
  const skills = [...new Set([...listDirs(path.join(C, 'skills')), SKILL_NAME])].sort().map((d) => {
    if (d === SKILL_NAME) return { name: d, desc: DESCRIPTION, userOnly: false };
    const t = readText(path.join(C, 'skills', d, 'SKILL.md'));
    if (t == null) return null;
    const fm = parseFrontmatter(t);
    return { name: d, desc: typeof fm.description === 'string' ? fm.description : '', userOnly: String(fm['disable-model-invocation']) === 'true' };
  }).filter(Boolean);

  const commands = listFiles(path.join(C, 'commands')).filter((f) => f.endsWith('.md')).map((f) => {
    const t = readText(path.join(C, 'commands', f)) || '';
    const fm = parseFrontmatter(t);
    const sub = [];
    const b = t.split(/^## /m).find((s) => /^B\.|^Sub-commands/i.test(s));
    if (b) for (const l of b.split(/\r?\n/)) if (/^- `/.test(l)) sub.push(l.replace(/^- /, ''));
    const c = t.split(/^## /m).find((s) => /^C\.|^Build flow/i.test(s));
    return { name: f.replace(/\.md$/, ''), desc: typeof fm.description === 'string' ? fm.description : '', hint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : '', userOnly: String(fm['disable-model-invocation']) === 'true', sub, build: c || '' };
  });

  const binDir = path.join(C, 'forge-bin');
  const tools = listFiles(binDir).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs')).map((f) => ({ file: f, purpose: headerPurpose(readText(path.join(binDir, f)), f) }));
  const purposeOf = Object.fromEntries(tools.map((t) => [t.file, t.purpose]));

  const settings = readJson(path.join(C, 'settings.json')) || {};
  const hooks = [];
  for (const [ev, arr] of Object.entries(isObj(settings.hooks) ? settings.hooks : {})) {
    for (const a of Array.isArray(arr) ? arr : []) for (const h of (a && Array.isArray(a.hooks) ? a.hooks : [])) {
      const m = String(h.command || '').match(/([A-Za-z0-9_.-]+\.(?:c?js|mjs|ps1|sh|py))/);
      if (m) hooks.push({ event: ev, matcher: a.matcher || '', script: m[1], purpose: purposeOf[m[1]] || '(script not in forge-bin)' });
    }
  }

  const gatesCfg = readJson(path.join(C, 'config/orchestration/hard-gates.json')) || {};
  const gates = (Array.isArray(gatesCfg.gates) ? gatesCfg.gates : []).filter((g) => g && g.id).map((g) => ({ id: g.id, cls: g.class || '', reason: g.reason || '', kind: (isObj(g.match) && g.match.kind) || '' }));

  const schema = readJson(path.join(C, 'config/orchestration/FORGE_CONFIG_SCHEMA.json')) || {};
  const config = realEntries(schema.settings).filter(([, v]) => isObj(v)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => ({ key: k, type: v.type || '', def: JSON.stringify(v.default), group: v.group || '', desc: (isObj(v.desc) && (v.desc.en || v.desc.nl)) || '' }));

  const routes = realEntries(routing.routes).filter(([, v]) => isObj(v)).map(([r, v]) => ({ route: r, model: v.model || '', effort: v.effort || '', agent: v.forgeAgent || '', when: v.when || '' }));
  const escalation = isObj(routing.escalation) ? routing.escalation : {};

  const checklist = ((readJson(path.join(C, 'config/orchestration/run-checklist.json')) || {}).steps || []).filter((s) => s && s.id);
  const workflows = listFiles(path.join(C, 'workflows')).filter((f) => /\.(c?js|mjs)$/.test(f)).map((f) => {
    const t = readText(path.join(C, 'workflows', f)) || '';
    const pick = (k) => { const m = t.match(new RegExp('\\b' + k + ":\\s*'([^']*)'")); return m ? m[1] : ''; };
    const phases = [...t.matchAll(/\{\s*title:\s*'([^']*)',\s*detail:\s*'([^']*)'\s*\}/g)].map((m) => ({ title: m[1], detail: m[2] }));
    return { file: f, name: pick('name') || f, desc: pick('description'), phases };
  });
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  return { bosses, specialists, unregistered, skills, commands, tools, hooks, gates, config, routes, defaults, escalation, checklist, workflows, exists };
}

// ---------- render ----------
function header(title, sources) {
  return [`<!-- ${GEN_MARK}; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->`, `# ${title}`, '', `Generated from: ${sources.map(code).join(', ')}.`, ''];
}
function agentTable(rows) {
  const out = ['| id | name | role | route | model / effort | preloaded skills | description |', '|---|---|---|---|---|---|---|'];
  for (const a of rows) {
    const fm = a.fm || {};
    const pre = Array.isArray(fm.skills) ? fm.skills.join(', ') : '';
    out.push(`| ${code(a.id)} | ${cell(a.name, 60)} | ${cell(a.role, 80)} | ${cell(a.route, 20)} | ${cell((fm.model || '?') + ' / ' + (fm.effort || '?'), 30)} | ${cell(pre, 200)} | ${cell(a.desc, 220)} |`);
  }
  return out;
}

function skillGroup(s) {
  if (/^playbook\b/i.test(s.desc)) return 'Forge playbooks (one per project type)';
  if (s.name.startsWith('forge-')) return 'Forge skills (process and method)';
  if (s.name.startsWith('roblox-')) return 'Roblox skills';
  return 'Vendored and other project skills';
}

function render(d) {
  const files = new Map();
  const cmdGates = d.gates.filter((g) => g.kind === 'command');
  const pathGates = d.gates.filter((g) => g.kind === 'path-escape');
  const ownerGates = d.gates.filter((g) => g.kind !== 'command' && g.kind !== 'path-escape');

  // agents.md
  files.set('references/agents.md', [
    ...header('Forge agents (Bosses and specialists)', ['.claude/config/agents/agent-registry.json', '.claude/FORGE_MODEL_ROUTING.json']).concat(['Agent files: `.claude/agents/` (one `<id>.md` per agent, frontmatter = model, effort, tools, preloaded skills).', '']),
    `## The ${d.bosses.length} permanent Bosses`, '', ...agentTable(d.bosses), '',
    `## ${d.specialists.length} specialists (dispatched only when a work package needs that domain)`, '', ...agentTable(d.specialists), '',
    ...(d.unregistered.length ? [`## ${d.unregistered.length} agent file(s) without a registry row`, '', ...agentTable(d.unregistered), ''] : []),
  ].join('\n'));

  // skills.md
  const groups = new Map();
  for (const s of d.skills) { const g = skillGroup(s); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  const skillLines = header(`Forge skills (${d.skills.length})`, ['.claude/skills/']).concat(['Each line: the skill name and its description (the line the model sees in the skill listing). Open a skill with the Skill tool, or Read its SKILL.md under the skills folder.', '']);
  for (const g of [...groups.keys()].sort()) {
    skillLines.push(`## ${g} (${groups.get(g).length})`, '');
    for (const s of groups.get(g)) skillLines.push(`- ${code(s.name)}${s.userOnly ? ' (user-invoked only)' : ''}: ${oneLine(s.desc, 240) || '(no description)'}`);
    skillLines.push('');
  }
  files.set('references/skills.md', skillLines.join('\n'));

  // commands.md
  const cmd = header('Forge slash commands', ['.claude/commands/']);
  for (const c of d.commands) {
    cmd.push(`## /${c.name}${c.userOnly ? ' (user-invoked only)' : ''}`, '', `- description: ${oneLine(c.desc, 300) || '(none)'}`);
    if (c.hint) cmd.push(`- arguments: ${code(oneLine(c.hint, 400))}`);
    if (c.sub.length) { cmd.push('', 'Sub-commands (from the command file, section B):', ''); for (const s of c.sub) cmd.push(`- ${oneLine(s, 400)}`); }
    cmd.push('');
  }
  files.set('references/commands.md', cmd.join('\n'));

  // hooks.md
  const hk = header(`Forge hooks (${d.hooks.length} registrations)`, ['.claude/settings.json']).concat(['Read only: this list mirrors the settings file. Writing the Claude Code settings files is an owner hard gate.', '', '| event | matcher | script | purpose (from its header) |', '|---|---|---|---|']);
  for (const h of d.hooks) hk.push(`| ${cell(h.event, 40)} | ${cell(h.matcher || '(all)', 60)} | ${code(h.script)} | ${cell(h.purpose, 220)} |`);
  files.set('references/hooks.md', hk.concat(['']).join('\n'));

  // gates.md
  const gateRows = (list) => ['| id | class | reason |', '|---|---|---|', ...list.map((g) => `| ${code(g.id)} | ${cell(g.cls, 20)} | ${cell(g.reason, 400)} |`)];
  files.set('references/gates.md', [
    ...header(`Forge hard gates (${d.gates.length})`, ['.claude/config/orchestration/hard-gates.json']),
    `## ${cmdGates.length} command gates: blocked by the PreToolUse gate hook`, '', 'The hook is a classifier, not a proof: what it does not recognise it does not stop (the file lists that under `_not_caught`).', '', ...gateRows(cmdGates), '',
    ...(pathGates.length ? [`## ${pathGates.length} path gate(s): classifier and prose`, '', ...gateRows(pathGates), ''] : []),
    `## ${ownerGates.length} owner gates: the owner decides`, '', 'A request that matches one of these waits for the owner (classifier on the text plus the written rule). They go into the one batched owner queue at the end of a run.', '', ...gateRows(ownerGates), '',
  ].join('\n'));

  // config.md
  files.set('references/config.md', [
    ...header(`Forge settings (${d.config.length})`, ['.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json']),
    'Read a setting with `node .claude/forge-bin/forge-config.cjs get <key>`; explain one with `explain <key>`. Only the owner changes settings.', '',
    '| key | type | default | group | what it does |', '|---|---|---|---|---|',
    ...d.config.map((c) => `| ${code(c.key)} | ${cell(c.type, 20)} | ${cell(c.def, 60)} | ${cell(c.group, 30)} | ${cell(c.desc, 300)} |`), '',
  ].join('\n'));

  // routes.md
  files.set('references/routes.md', [
    ...header('GOAT model routes', ['.claude/FORGE_MODEL_ROUTING.json']),
    '| route | model | effort | Forge agent | when |', '|---|---|---|---|---|',
    ...d.routes.map((r) => `| ${code(r.route)} | ${cell(r.model, 20)} | ${cell(r.effort, 20)} | ${cell(r.agent, 30)} | ${cell(r.when, 400)} |`), '',
    '## Default route per agent', '', ...Object.keys(d.defaults).sort().map((a) => `- ${code(a)}: ${d.defaults[a]}`), '',
    '## Escalation', '', ...realEntries(d.escalation).concat(d.escalation._doc ? [['rule', d.escalation._doc]] : []).map(([k, v]) => `- ${k}: ${oneLine(typeof v === 'string' ? v : JSON.stringify(v), 400)}`), '',
  ].join('\n'));

  // tools.md
  files.set('references/tools.md', [
    ...header(`Forge tools (${d.tools.length} scripts)`, ['.claude/forge-bin/']).concat(['Every script in the folder, tests left out. Purpose = the first sentence of the file header. Run a tool with `node .claude/forge-bin/<file> --help` before you rely on it.', '']),
    '| file | purpose |', '|---|---|', ...d.tools.map((t) => `| ${code(t.file)} | ${cell(t.purpose, 240)} |`), '',
  ].join('\n'));

  // workflows.md
  const forgeCmd = d.commands.find((c) => c.name === 'forge');
  const flow = [];
  if (forgeCmd && forgeCmd.build) {
    for (const l of forgeCmd.build.split(/\r?\n/)) {
      if (/^\d+\.\s/.test(l)) flow.push(oneLine(l, 400));
      const row = l.match(/^\|\s*([0-9—-]+)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
      if (row && !/^-+$/.test(row[1])) flow.push(`- step ${row[1]}: ${oneLine(row[2], 600)} (reference: ${oneLine(row[3], 120)})`);
    }
  }
  const resumeSub = forgeCmd ? forgeCmd.sub.filter((s) => /^`resume/.test(s)) : [];
  const wf = header('How a Forge run goes', ['.claude/commands/forge.md', '.claude/config/orchestration/run-checklist.json', '.claude/workflows/']);
  wf.push('Order: `/forge <task>` starts a run → run contract plan → work packages (Head Chef triage) → routed lanes (Bosses) → Verify Boss per package → report → run contract `check --finalize`.', '');
  wf.push('## Build flow (from the /forge command file, section C)', '', ...(flow.length ? flow : ['(no build-flow section found)']), '');
  wf.push(`## Run checklist (${d.checklist.length} steps)`, '', ...d.checklist.map((s, i) => `${i + 1}. ${code(s.id)}${s.required ? '' : ' (advisory)'}: ${oneLine(s.label, 300)}`), '');
  wf.push(`## Workflow scripts (${d.workflows.length})`, '');
  for (const w of d.workflows) { wf.push(`- ${code(w.name)}: ${oneLine(w.desc, 300) || '(no description)'}`); for (const p of w.phases) wf.push(`  - ${oneLine(p.title, 60)}: ${oneLine(p.detail, 200)}`); }
  wf.push('', '## Resume a run', '', ...(resumeSub.length ? resumeSub.map((s) => '- ' + oneLine(s, 400)) : ['- (no resume sub-command found)']));
  if (d.tools.some((t) => t.file === 'forge-swarm-resume.cjs')) wf.push('- Tool: `node .claude/forge-bin/forge-swarm-resume.cjs --run <run_id>` (exit 0 = nothing to resume, 3 = resumable, 4 = not complete but every unfinished package is leased elsewhere, 2 = no manifest was armed; --refresh/--release --wp <id> --token <t> manage a claimed lease). Re-dispatch only the unfinished packages; a done package is never re-dispatched.');
  const brief = d.hooks.find((h) => h.script === 'forge-resume-brief.cjs');
  if (brief) wf.push(`- After a limit, /clear or restart: the ${brief.event} hook ${code(brief.script)} injects the starting facts. Then read the state files and start every independent item again.`);
  if (d.exists('.claude/docs/forge-reference/resume.md')) wf.push('- Full rule: `.claude/docs/forge-reference/resume.md`.');
  files.set('references/workflows.md', wf.concat(['']).join('\n'));

  // limits.md
  files.set('references/limits.md', [
    ...header('What this skill cannot do', ['.claude/settings.json', '.claude/config/orchestration/hard-gates.json']),
    'A skill is text the model reads. It carries the knowledge of Forge and one entry point into it. It **cannot enforce** anything:', '',
    '- It cannot block a tool call. Blocking lives in hooks that Claude Code runs as code, outside the model.',
    '- It cannot stop a push, a deploy or a delete. The command gates are a PreToolUse hook; the owner gates are a classifier plus the owner\'s decision.',
    '- It cannot dispatch a Boss, pick a model or set effort. Agents are agent files plus the Agent tool or a Workflow `agent()` call.',
    '- It cannot write run events, the ledger or memory, and it cannot prove a check ran. Scripts do that and leave evidence.',
    '- It may not fire at all: a skill triggers only when its description matches, and a long skill listing can drop descriptions.',
    '- It goes stale: it is a snapshot of the data at its last `generate`. `check` shows when it no longer matches.',
    '- A portable copy (export) carries the knowledge only. In a project without Forge installed none of the tools, hooks or gates named here exist.', '',
    `## What does enforce (in this project, today)`, '',
    `- ${d.hooks.length} hook registrations in the settings file (see \`references/hooks.md\`).`,
    `- ${cmdGates.length} command gates blocked by the gate hook: ${cmdGates.map((g) => code(g.id)).join(', ') || '(none)'}.`,
    '- The run contract and the Stop hook refuse a close over a red contract.',
    '- Tests and the doctor turn red when the code breaks.', '',
  ].join('\n'));

  // SKILL.md
  const r = Object.fromEntries(d.routes.map((x) => [x.route, x]));
  const routeLine = ['triage', 'quick', 'build', 'deep', 'escalate', 'verifier'].filter((k) => r[k]).map((k) => `${k} ${r[k].model}/${r[k].effort}`).join(' · ');
  const tool = (f, rest) => `\`node .claude/forge-bin/${f}${rest ? ' ' + rest : ''}\``;
  const refs = [
    ['agents.md', `${d.bosses.length} Bosses and ${d.specialists.length} specialists: role, route, model, preloaded skills`],
    ['skills.md', `all ${d.skills.length} project skills with their description, grouped`],
    ['commands.md', `${d.commands.length} slash commands and the /forge sub-commands`],
    ['hooks.md', `${d.hooks.length} hook registrations and what each script does`],
    ['gates.md', `${d.gates.length} hard gates: which a hook blocks, which the owner decides`],
    ['config.md', `${d.config.length} settings with type, default and meaning`],
    ['routes.md', 'GOAT routes, default route per agent, escalation'],
    ['tools.md', `${d.tools.length} scripts in forge-bin with their purpose`],
    ['workflows.md', 'how a run goes, the run checklist, workflow scripts, resume'],
    ['limits.md', 'what a skill cannot enforce, and what does'],
  ];
  files.set('SKILL.md', [
    '---', `name: ${SKILL_NAME}`, `description: "${DESCRIPTION}"`, '---', `<!-- ${GEN_MARK}; do not edit by hand, run: node .claude/forge-bin/forge-system-skill.cjs generate -->`, '',
    '# Forge system: the whole map in one skill', '',
    'Forge is a multi-agent build system on top of Claude Code: a Lead routes work to fixed Bosses, every package is verified, and a run closes only through its run contract. This skill is the table of contents; the lists live in `references/`, generated from the real config.', '',
    '**A skill cannot enforce anything.** It carries the knowledge and the entry point. The hooks, gates, scripts and agents that make the rules hold are code. Detail: `references/limits.md`.', '',
    '## When to use', '- Someone asks what Forge is, how a run works, which Boss does what, what stops a push, what a setting does, or how to resume.', '- A fresh agent in a Forge project needs the map before it acts.',
    '- Not for: starting a build (`forge-router` and the /forge command), a domain playbook (see `references/skills.md`), the house rules every agent follows (`forge-conduct`).', '',
    '## Operating rules', '',
    `1. **Run contract.** A run starts with ${tool('forge-start.cjs', '--text "<request>"')} and closes only through ${tool('forge-runcontract.cjs', 'plan --run <run_id>')} up to \`check --finalize\`. Never claim done over a red contract. See \`references/workflows.md\`.`,
    `2. **GOAT routes.** Head Chef triages every package to a route: ${routeLine}. One escalation on a failed check, never more. See \`references/routes.md\`.`,
    `3. **Bosses.** Work goes to the ${d.bosses.length} permanent Bosses (${d.bosses.map((b) => b.name).join(', ')}); specialists only for their domain. Never invent agent names. See \`references/agents.md\`.`,
    `4. **Lanes.** Independent parts run in parallel, as many as ${tool('forge-lane-budget.cjs')} allows. One writer per file: each writer gets its own worktree and branch; the Lead merges.`,
    `5. **Gates.** ${cmdGates.length} command gates are blocked by a hook; ${ownerGates.length + pathGates.length} more wait for the owner (push, deploy, spend, credentials, outbound, production). See \`references/gates.md\`.`,
    `6. **Scribe.** Every owner instruction is captured verbatim with ${tool('forge-scribe.cjs', 'capture')}; ${tool('forge-scribe.cjs', 'gate')} runs before completion.`,
    '7. **Memory.** Read the project profile, memory and task history under `.claude/` before a task; append after it with evidence only. Each agent keeps lessons in its own folder under `.claude/agent-memory/`.',
    `8. **Owner queue.** A report hands the owner hard gates only, in one batched list at the end, never a choice the Lead can make (${tool('forge-owner-queue-check.cjs')}).`,
    `9. **Resume.** \`/forge resume <run_id>\` reconciles the run from its events and re-dispatches only unfinished packages. See \`references/workflows.md\`.`,
    `10. **Evidence.** Every claim needs a real run of the check; Verify Boss passes or fails each package and never edits.`, '',
    '## Map', '', '| file | what is in it |', '|---|---|', ...refs.map(([f, w]) => `| \`references/${f}\` | ${w} |`), '',
    '## Keeping it true', '',
    `- Regenerate after a config change: ${tool('forge-system-skill.cjs', 'generate')}. Never edit these files by hand.`,
    `- ${tool('forge-system-skill.cjs', 'check')} exits 1 when a file is stale, a path reference is dead or a secret pattern appears.`,
    `- Portable copy for another project or the user skills folder: ${tool('forge-system-skill.cjs', 'export --out <dir>')} (SKILL.md and references only).`, '',
  ].join('\n'));
  return files;
}

/** neutralizeRefs(text, root, skillDir): a backticked anchored path that would not resolve becomes plain text. */
function neutralizeRefs(text, root, skillDir) {
  if (!hygiene || typeof hygiene.extractSkillPathRefs !== 'function') return text;
  return text.replace(/`([^`\n]+)`/g, (whole, inner) => {
    const refs = hygiene.extractSkillPathRefs(whole);
    if (!refs.length || !refs[0].anchored) return whole;
    return refDangles(refs[0].ref, root, skillDir) ? inner : whole;
  });
}
function refDangles(ref, root, skillDir) {
  const resolved = ref.startsWith('.claude/') ? path.resolve(root, ref) : path.resolve(skillDir, ref);
  let isFile = false;
  try { isFile = fs.statSync(resolved).isFile(); } catch { isFile = false; }
  return !isFile || LOCAL_ONLY_RE.test(ref);
}

/** build(root) -> Map<relPathInsideSkill, text>; pure read of the sources, writes nothing. */
function build(root) {
  const r = path.resolve(String(root || DEFAULT_ROOT));
  const skillDir = path.join(r, SKILL_REL);
  const files = render(collect(r));
  // SKILL.md pointers to references/ must resolve against the set being written, not the disk (first run).
  const names = new Set(files.keys());
  const out = new Map();
  for (const [rel, text] of files) {
    const t = text.replace(/`([^`\n]+)`/g, (whole, inner) => {
      if (/^references\/[A-Za-z0-9_.-]+\.md$/.test(inner)) return names.has(inner) ? whole : inner;
      return neutralizeRefs(whole, r, skillDir);
    });
    out.set(rel, t.endsWith('\n') ? t : t + '\n');
  }
  return out;
}

function norm(t) { return String(t).replace(/\r\n/g, '\n'); }
function writeIfChanged(p, text, written, label) {
  if (readText(p) != null && norm(readText(p)) === text) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  written.push(label);
}
function generatedOrphans(skillDir, names) {
  const refDir = path.join(skillDir, 'references');
  return listFiles(refDir).filter((f) => f.endsWith('.md') && !names.has('references/' + f) && (readText(path.join(refDir, f)) || '').includes(GEN_MARK)).map((f) => 'references/' + f);
}

function generate(opts = {}) {
  const root = path.resolve(String(opts.root || DEFAULT_ROOT));
  const skillDir = path.join(root, SKILL_REL);
  const files = build(root);
  const written = []; const removed = [];
  for (const [rel, text] of files) writeIfChanged(path.join(skillDir, rel), text, written, rel);
  for (const rel of generatedOrphans(skillDir, new Set(files.keys()))) { fs.unlinkSync(path.join(skillDir, rel)); removed.push(rel); }
  return { skillDir, files: files.size, written, removed };
}

function check(opts = {}) {
  const root = path.resolve(String(opts.root || DEFAULT_ROOT));
  const skillDir = path.join(root, SKILL_REL);
  const files = build(root);
  const stale = [];
  for (const [rel, text] of files) { const disk = readText(path.join(skillDir, rel)); if (disk == null || norm(disk) !== text) stale.push(rel); }
  stale.push(...generatedOrphans(skillDir, new Set(files.keys())));
  const onDisk = ['SKILL.md', ...listFiles(path.join(skillDir, 'references')).filter((f) => f.endsWith('.md')).map((f) => 'references/' + f)].filter((rel) => fs.existsSync(path.join(skillDir, rel)));
  const deadRefs = []; const secrets = [];
  for (const rel of onDisk) {
    const text = readText(path.join(skillDir, rel)) || '';
    if (hygiene && typeof hygiene.extractSkillPathRefs === 'function') {
      for (const ref of hygiene.extractSkillPathRefs(text)) if (ref.anchored && refDangles(ref.ref, root, skillDir)) deadRefs.push({ file: rel, ref: ref.ref });
    }
    if (scrubber && typeof scrubber.scanText === 'function') secrets.push(...scrubber.scanText(text, rel));
    else text.split(/\r?\n/).forEach((l, i) => { if (redact(l) !== l) secrets.push({ file: rel, line: i + 1, pattern: 'secret-pattern' }); });
  }
  return { ok: stale.length === 0 && deadRefs.length === 0 && secrets.length === 0, skillDir, stale, deadRefs, secrets, checkedFiles: onDisk.length };
}

function exportTo(opts = {}) {
  const root = path.resolve(String(opts.root || DEFAULT_ROOT));
  if (!opts.out) throw new Error('export needs --out <dir>');
  const out = path.resolve(String(opts.out));
  const skillDir = path.join(root, SKILL_REL);
  const relToSkill = path.relative(skillDir, out);
  if (!relToSkill || (!relToSkill.startsWith('..') && !path.isAbsolute(relToSkill))) throw new Error('refusing to export into the source skill folder: ' + out);
  const written = [];
  for (const [rel, text] of build(root)) writeIfChanged(path.join(out, rel), text, written, rel);
  return { out, written };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if ((a === '--root' || a === '--out') && argv[i + 1] != null) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
const USAGE = 'usage: node forge-system-skill.cjs generate|check [--root <dir>] [--json] | export --out <dir> [--root <dir>] [--json]';
function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (o.help) { console.log(USAGE); return 0; }
  const print = (obj, line) => console.log(o.json ? JSON.stringify(obj, null, 2) : line);
  try {
    if (cmd === 'generate') { const r = generate(o); print(r, `forge-system: ${r.files} files, ${r.written.length} written${r.written.length ? ' (' + r.written.join(', ') + ')' : ''}, ${r.removed.length} removed`); return 0; }
    if (cmd === 'check') {
      const r = check(o);
      const lines = [`forge-system check: ${r.ok ? 'OK' : 'PROBLEMS'} (${r.checkedFiles} files)`];
      if (r.stale.length) lines.push('stale: ' + r.stale.join(', ') + ' (run generate)');
      for (const d of r.deadRefs) lines.push(`dead ref: ${d.ref} in ${d.file}`);
      for (const s of r.secrets) lines.push(`secret pattern: ${s.file}:${s.line} (${s.pattern})`);
      print(r, lines.join('\n'));
      return r.ok ? 0 : 1;
    }
    if (cmd === 'export') {
      if (!o.out) { console.error(USAGE); return 2; }
      const r = exportTo(o); print(r, `forge-system export: ${r.written.length} written to ${r.out}`); return 0;
    }
  } catch (e) { console.error('forge-system-skill: ' + e.message); return 2; }
  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { build, generate, check, exportTo, parseFrontmatter, headerPurpose, GEN_MARK, SKILL_REL, DESCRIPTION };
