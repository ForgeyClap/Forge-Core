#!/usr/bin/env node
'use strict';
/**
 * forge-wp11-coverage.test.cjs — rule-coverage guard (* `.claude/commands/forge.md` and `.claude/skills/forge-router/SKILL.md` were cut down to a
 * short always-loaded core, and their full wording was moved VERBATIM into
 * `.claude/docs/forge-reference/forge-cmd-*.md` and `router-*.md`.
 *
 * The owner's standing rule for this kind of trim (FORGE_STANDING_RULES.user.json): move text
 * into on-demand references instead of deleting it, keep every rule reachable, and prove with before/after
 * tests that nothing was lost. This file is that proof, in the same shape as forge-md-coverage.test.cjs:
 * every heading and bold span of the PRE-WP-11 files (frozen below, extracted with the identical
 * extractTitles rule from the working-tree files whose sha256 is recorded in FROZEN.*.sha256) must still be
 * findable, whitespace-normalized, in the current core OR in a reference doc that core literally links to.
 *
 * It also pins the shrink itself (a byte budget per core, so a later edit cannot quietly regrow the
 * always-loaded text) and the anchors that must survive compaction or that other tools parse
 * (forge-audit-loop reads the router's "## Step 1" table; forge-webquality/forge-quality/forge-playbooks
 * tests read router keywords; the run-contract and scribe commands must be in the /forge core).
 *
 * WHAT THIS DOES NOT PROVE: that a fresh session actually opens the reference doc when it reaches a step.
 * That is a behavioural question no string test can answer (see the report).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REF_DIR = path.join(ROOT, '.claude', 'docs', 'forge-reference');
const CORES = {
  forge: path.join(ROOT, '.claude', 'commands', 'forge.md'),
  router: path.join(ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'),
};
const CORE_BYTE_BUDGET = 16384; // ~4k tokens by the bytes/4 estimate (blueprint target)

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function normalizeWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** Same rule as forge-md-coverage.test.cjs::extractTitles (headings + bold spans, lone `*` safe). */
function extractTitles(text) {
  const titles = [];
  const seen = new Set();
  const add = (raw) => { const n = normalizeWs(raw); if (n && !seen.has(n)) { seen.add(n); titles.push(n); } };
  const headingRe = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = headingRe.exec(text))) add(m[1]);
  const boldRe = /\*\*((?:(?!\*\*)[\s\S])+?)\*\*/g;
  while ((m = boldRe.exec(text))) add(m[1]);
  return titles;
}
function linkedDocs(coreText) {
  const re = /\.claude\/docs\/forge-reference\/([A-Za-z0-9_-]+\.md)/g;
  const names = [];
  let m;
  while ((m = re.exec(coreText))) if (!names.includes(m[1])) names.push(m[1]);
  return names.map((name) => {
    const p = path.join(REF_DIR, name);
    const exists = fs.existsSync(p);
    return { name, exists, text: exists ? fs.readFileSync(p, 'utf8') : '' };
  });
}

const FROZEN = {
  "forge": {
    "source": ".claude/commands/forge.md",
    "sha256": "6ab6d9160d6d321dff530a6b2c25e4c0c1a8d4c85ab8aaeb6595b7ef2b6dfdbd",
    "bytes": 55563,
    "docs": [
      "forge-cmd-subcommands.md",
      "forge-cmd-session-build-default.md",
      "forge-cmd-gates-verify.md",
      "forge-cmd-routing-cache-bosses.md",
      "forge-cmd-intake-install-ecc.md",
      "forge-cmd-steps-0-3.md",
      "forge-cmd-steps-4-6.md",
      "forge-cmd-steps-7-14.md"
    ],
    "titles": [
      "/forge",
      "Sub-commands & natural-language triggers (check $ARGUMENTS first)",
      "Forge Session Mode (project-local)",
      "0. Owner Prefs, Standing Rules & Autonomy (required, before Mission Intake) — WAVE B / B4",
      "1. Mission Intake",
      "2. Deep Prompt Analysis (load memory + ECC inventory)",
      "3. Mission Blueprint / Master Plan (the Lead Agent plans BEFORE executing)",
      "3a. Skill Discovery (required before assigning subagents) — log `skill_discovery` then `skill_map_created`",
      "4. Dynamic Role-Based Subagent Selection → load skill `forge-router`",
      "5. Assign Subagent Work Packages",
      "6. Parallel Subagent Execution (this folder only) — ECC-first",
      "7. Subagent Outputs / Artifacts",
      "8. Lead Review + Rework Loop (bounded)",
      "9. Merge & Synthesis",
      "10. Codex Review + Unlock (optional, strong for code/architecture/automation/dashboard/refactor/high-end)",
      "11. Quality Gate → Final Output",
      "12. Memory Update (always)",
      "13. Dashboard Update + Browser Proof",
      "14. Final Report → load skill `forge-report`",
      "Quality Loop (steps 8–11, autonomous)",
      "Honesty (hard rule)",
      "$ARGUMENTS",
      "`config`",
      "`help me ask`",
      "`dashboard`",
      "the ONE dashboard for every project",
      "health-check",
      "`http://127.0.0.1:4100`",
      "never claim it is running unless that check passed; never fake a start",
      "Do NOT try to fall back to the old per-project Control Center",
      "run the CLI yourself",
      "`start`",
      "`interview`",
      "`propose-skill`",
      "`approve-skill <name> --owner-approval <token>`",
      "`tournament`",
      "`secondbrain`",
      "`codemodel`",
      "`briefing <run_id>`",
      "`use`",
      "`status`",
      "`repair`",
      "yourself",
      "`runs`",
      "`resume <run_id>`",
      "`open-report`",
      "`learn`",
      "cross-project learning harvest",
      "`remember <text>`",
      "ONLY",
      "`snapshot`",
      "automatically",
      "Forge Session Mode",
      "follow-up prompts in this project as part of the current Forge session",
      "Pause/stop:",
      "Status:",
      "no extra permission",
      "FORGE SESSION",
      "BUILD BY DEFAULT (beginner-first — external audit 2026-09-23 replaced the old ARM → START gate; config-driven since v2.7.0, 2026-09-24).",
      "target folder",
      "goal intake",
      "dashboard",
      "never print a start or build command for the user to type",
      "usage guard",
      "git checkpoint",
      "a refused checkpoint never stops the build",
      "PRD for any L2+ build",
      "contract preview",
      "Destructive words",
      "continue straight into building",
      "START gate = config `start-gate`:",
      "L4",
      "\"Smallest team\" is about team SIZE, and the ceremony scales with the level:",
      "NEVER author/redesign your own dashboard — always COPY the canonical one",
      "BEGINNER PROMISE (owner directive 2026-09-24).",
      "GATE HOOK — the yes-path (config `gate-hook`, default on).",
      "VERIFY-AND-CORRECT + SCREENSHOT PROOF (per task).",
      "MODEL ROUTING (quota tiering).",
      "GOAT router",
      "Triage",
      "Dispatch",
      "Verify",
      "Escalate ONCE",
      "CACHE DISCIPLINE (usage-minimisation research 2026-09-26 — every request re-sends the cached context, and a cache miss costs roughly 25-40x a cache read of the same content).",
      "PERMANENT BOSSES + QA LOOP + NVIDIA ROUTING.",
      "GOAL INTAKE + PLAN (every `gebruik Forge`/`use Forge`, even outside plan mode — silent by default since 2026-09-23, see BUILD BY DEFAULT above).",
      "CLAUDE.md",
      "PAPERCLIP — OPT-IN ONLY (decoupled from `gebruik forge`; user decision 2026-07-04).",
      "On install / first activation, maintain the project's CLAUDE.md + skills (Forge maintains four things: CLAUDE.md · `.claude/skills/*` · memory · dashboard).",
      "preserve all existing rules, and add/refresh only a clearly-marked `## Forge Studio v7` section",
      "skill registry",
      "Custom Skills",
      "Codex",
      "Browser Proof",
      "fresh-install verification",
      "Lead-Agent Swarm Execution Loop",
      "Lead Agent / Orchestrator",
      "real",
      "ECC-first (ECC Normal Mode — default ON).",
      "ECC agents/skills",
      "really try to invoke them",
      "`runtime`",
      "labeled fallback",
      "ECC Full Test Mode",
      "first",
      "Then",
      "Real-fixtures intake (WAVE D, correctness-critical domains only).",
      "Take the ECC inventory",
      "Lead Agent",
      "detected project type",
      "custom taxonomy",
      "do-not-touch list",
      "a Skill Discovery section (below)",
      "final control over skill selection",
      "examples, not limits",
      "existing project-local skills",
      "global Forge skills",
      "available ECC agents/skills",
      "## Skill Discovery",
      "If a needed skill doesn't exist, do not ignore the gap",
      "native fallback method (labeled honestly)",
      "BLOCKED",
      "No executable subagent runs without an assigned skill/method/capability route.",
      "decides the roles",
      "team names come from the permanent Boss registry",
      "smallest useful but powerful",
      "custom",
      "each",
      "plus the assigned `skill` + `skill_source`",
      "blue",
      "different",
      "CONTRACT-FIRST (required before any parallel builders that share interfaces).",
      "INTEGRATION GATE before \"complete\":",
      "REAL DISPATCH OR HONEST INTERNAL (hard rule — deep-scan 2026-07-07).",
      "If YOU (the main session) do the work yourself, do NOT emit a separate named subagent — log it under the Lead/Boss node with `runtime:\"internal\"` (INTERNAL ROLE ONLY).",
      "Really invoke the selected ECC agents/skills",
      "Fallback:",
      "only if safe",
      "SUBAGENT LIVE LOGGING (required — the dashboard must show WHAT each subagent is doing, not just its .md).",
      "each meaningful step",
      "Lead backfills their events from the subagent's returned result immediately after it completes, tagged with that subagent's `dispatch_id`",
      "DEFAULT path for these classes, not a fallback exception",
      "≥3 real activity events per subagent",
      "For every work package logged in step 5, also log `wp_completed` carrying that exact `wp_id` (`{\"wp_id\":\"<id>\"}`) the moment it really finishes — or `wp_failed` with the same `wp_id` when it does not.",
      "reviews all subagent outputs",
      "Critical/high must be fixed before final output; medium/minor may be fixed or reported. Max 2 loops default / 3 high-end. Never loop forever",
      "Config `codex-review` decides whether this runs:",
      "If Codex truly runs",
      "if it can't",
      "Codex unlock diagnosis",
      "never construct or hand the beginner a command to type",
      "CODEX REAL INVOKED · BLOCKED: TRUST/TTY · BLOCKED: NO GIT · BLOCKED: NO OUTPUT · NOT AVAILABLE · NOT INVOKED · FALLBACK USED",
      "Never fake Codex or claim proof without real output.",
      "Runtime",
      "custom subagents/skills",
      "Retention = config `cleanup`:",
      "Artifact Collector",
      "Browser proof (v7.1):",
      "PARTIAL",
      "RUN-CONTRACT GATE (required BEFORE `run_completed` — wired 2026-08-02; before this date the gate existed but had no call site and was evaluated exactly 0 times in 846 real events, which the owner experienced as \"agents forget the tasks\").",
      "never log `run_completed` over a red contract.",
      "Skill Discovery",
      "custom subagents",
      "ECC status block",
      "Codex status",
      "Browser proof status",
      "CLAUDE.md created/updated/no-change/conflict + what was preserved",
      "custom SKILL.md files created/updated/used + Skill Registry status",
      "not",
      "strict verdict",
      "no fake claims",
      "For beginners, also:",
      "\"Wat is er veranderd\"",
      "No fake agents, custom subagents, custom skills, Codex, tests, files changed, live activity, or progress.",
      "ECC honesty:",
      "Session Mode"
    ]
  },
  "router": {
    "source": ".claude/skills/forge-router/SKILL.md",
    "sha256": "66355b53d6a9f698d081e1a53a2595386a75871c86b88753bfca04435bae7184",
    "bytes": 52915,
    "docs": [
      "router-intake-and-skill-discovery.md",
      "router-classify-domain-complexity.md",
      "router-team-routing-and-goat.md",
      "router-web-quality-mcp-wave-j.md",
      "router-parallel-handoff-review.md",
      "router-team-plan-and-work-packages.md",
      "router-dispatch-v10-contract-first.md"
    ],
    "titles": [
      "Forge router (agent selection)",
      "Step 0 — Read project memory + ECC inventory first (required)",
      "Step 0-owner — Owner Prefs, Standing Rules & Autonomy (required, before intake) — WAVE B / B4",
      "ECC-first selection (the routing rule)",
      "Step 0a — Prompt Master INTAKE (REQUIRED for BUILD tasks — capture the goal first)",
      "Step 0b — Skill Discovery (REQUIRED, before assigning subagents)",
      "Dynamic + custom roles (examples are guidance, not limits)",
      "Step 1 — Classify the domain (Quality Intelligence, REQUIRED for BUILD tasks)",
      "Step 2 — Classify complexity (L1–L4)",
      "Step 3 — Domain → team routing (exact ECC names; specialists are CONDITIONAL by stack/level)",
      "Step 3x — GOAT model routing (HARD MUST, 2026-10-06)",
      "Step 3a — Auto Web-Quality Contract (default, not re-requested) — WAVE C / C3, 2026-07-18",
      "Step 3b — External tool access (MCP, dormant/opt-in by default) — WAVE G",
      "Step 3c — Wave J tools (tournament / second brain / codemodel / nightshift / guardian) — opt-in, 2026-07-19",
      "Step 4 — Parallel vs serial",
      "Step 4b — Dynamic Workflows for L3/L4 mass fan-out (scout #5, 2026-07-13)",
      "Step 4c — SendMessage Boss-to-Boss pipeline handoff (serial pipelines, 2026-07-24)",
      "Step 5 — Review & delivery (optional, non-blocking)",
      "Step 6 — Load the playbook",
      "Output: TEAM PLAN + Project Adaptation",
      "Role bands (for the Control Center swarm graph)",
      "Emit Work Packages (high-end runs)",
      "Step 4d — WP-dispatch v10 (autonomous split · verify-binding default · usage-pressure read) — 2026-07-25",
      "Contract-first + integration gate (multi-module builds)",
      "Self-improvement substrate (wp-skill-evals, 2026-07-31):",
      "router",
      "not",
      "TEAM PLAN",
      "Project Adaptation",
      "Take the ECC inventory",
      "`config/orchestration/precedence.md`",
      "the owner config",
      "owner config = tier 3, next to the standing rules",
      "applied-prefs ECHO",
      "`/forge remember`",
      "ECC-based",
      "real ECC agent/skill",
      "labeled fallback",
      "`runtime`",
      "silently",
      "answer every question yourself",
      "Assumptions (auto-filled)",
      "The mode is the owner config `intake`",
      "With config `prompt-doctor` on (default), coach the raw request first:",
      "at most one",
      "Then write the PRD — this is a numbered obligation with a runnable command, not a suggestion (wired 2026-08-02; before that, this sentence named `forge-prd` as a word with no command, and the tool ran exactly ONCE in the project's entire 29-run history): `node .claude/forge-bin/forge-prd.cjs write '<prd-json>' --run <run_id> --tickets` — one ticket per acceptance criterion; those tickets are what the run-contract gate and forge-verify hold the run to at completion.",
      "Lead Agent has final control over skill selection",
      "examples, not fixed menus and not restrictions",
      "dynamically discover, choose, assign, or create",
      "existing project-local skills",
      "global Forge skills",
      "available ECC agents/skills",
      "## Skill Discovery",
      "Skill gaps:",
      "create a project-local custom skill",
      "plan/scaffold for user approval",
      "native fallback method, labeled honestly",
      "BLOCKED",
      "Invoke `forge-genesis.cjs propose` WHEN",
      "and config `skill-proposals` is on",
      "Every executable subagent must have an assigned skill/method/capability route",
      "`CLAUDE.md`",
      "skill registry",
      "decides the team",
      "create a custom project-specific subagent role",
      "create a custom project taxonomy + custom subagents + matching custom-skill strategy",
      "Before planning a genuinely new/ambiguous approach:",
      "Run the ONE executable analysis entrypoint FIRST",
      "Log the trigger decision as a `decision_logged` event — ALSO when the mode is NONE",
      "Card handling always folds into `forge-payments`",
      "store",
      "desktop app",
      "voice agent",
      "Cap the roster at the owner config `team-max`",
      "Invoke `forge-repomap.cjs` WHEN",
      "and config `code-index` is on",
      "then",
      "Triage first:",
      "Dispatch on the route model:",
      "Ultracode (on by default):",
      "Verify:",
      "One escalation:",
      "website, landing, spa, or fullstack",
      "auto-prepends",
      "default builder obligation",
      "required-evidence set",
      "Invoke `forge-mcp-gate.cjs` WHEN",
      "and config `mcp` is on",
      "`forge-mcp-clients`",
      "dormant + opt-in by default",
      "and",
      "native fallback",
      "Invoke `forge-tournament.cjs` WHEN",
      "wide solution space",
      "Invoke `forge-secondbrain.cjs` WHEN",
      "cross-project/portfolio",
      "`forge-codemodel.cjs`",
      "repo-context",
      "Invoke `forge-beads.cjs` WHEN",
      "`forge-nightshift` skill",
      "opt-in",
      "`forge-audit-loop.cjs`",
      "opt-in and non-self-scheduling",
      "`forge-guardian` skill",
      "owner-gated scaffold only",
      "`forge-scout` skill",
      "`forge-projectbrain` skill/tool",
      "independent",
      "you are the integration layer",
      "Hotspot lock protocol (mechanical \"one writer per hotspot\", 2026-07-26):",
      "Pre-launch overlap check (`forge-runwatch`, HARD MUST #2 pre-launch half):",
      "L3/L4 mass fan-out",
      "dynamic Workflow",
      "serial",
      "SendMessage",
      "named",
      "owner-opt-in",
      "Lead relays",
      "The Lead stays the integration layer",
      "Prove completion before treating a handoff as done:",
      "`codex-review`",
      "important",
      "Built-in second passes:",
      "advisory",
      "agents not used and why",
      "control",
      "context",
      "planning",
      "domain",
      "execution",
      "review",
      "report",
      "custom",
      "runtime",
      "skill",
      "skill_source",
      "route",
      "risk",
      "checks",
      "model",
      "effort",
      "rework_criteria",
      "blue",
      "Lean-return clause (token efficiency, 2026-07-13):",
      "Prompt Master shaping clause (2026-07-13):",
      "No work on a silent guess (wave 1, 2026-10-01):",
      "Bugs back into the spec, and loop health (wave 2, 2026-10-01):",
      "Lesson-recall clause (self-learning loop, forge-core add-on 2026-07-12):",
      "Live-logging clause (REQUIRED in every dispatched subagent prompt):",
      "Verify-parity warning (learned 2026-07-12, run evolver-research):",
      "Verify Boss"
    ]
  }
};

console.log('forge-wp11-coverage tests (WP-11 core + verbatim reference docs)');

t('the extraction rule still parses a lone-asterisk glob without mis-pairing bold spans', () => {
  const got = extractTitles('## 1. Intake\nA **bold** and `.claude/skills/*` then **second bold**.');
  assert(got.includes('1. Intake') && got.includes('bold') && got.includes('second bold'), JSON.stringify(got));
});

for (const key of Object.keys(CORES)) {
  const frozen = FROZEN[key];
  const coreText = fs.readFileSync(CORES[key], 'utf8');
  const linked = linkedDocs(coreText);
  const haystack = normalizeWs(coreText + ' ' + linked.map((d) => d.text).join(' '));

  t(key + ': frozen fixture is non-trivial (' + frozen.titles.length + ' titles)', () => {
    assert(frozen.titles.length >= 100, 'expected >= 100 frozen titles');
  });
  t(key + ': core stays within the always-loaded byte budget (' + Buffer.byteLength(coreText) + ' <= ' + CORE_BYTE_BUDGET + ')', () => {
    assert(Buffer.byteLength(coreText) <= CORE_BYTE_BUDGET, 'core regrew past the WP-11 budget; move detail to a reference doc instead');
  });
  t(key + ': core is much smaller than the pre-WP-11 file (' + frozen.bytes + ' bytes)', () => {
    assert(Buffer.byteLength(coreText) < frozen.bytes / 2, 'core is not at most half the old size');
  });
  t(key + ': every reference doc the core links to exists', () => {
    const missing = linked.filter((d) => !d.exists).map((d) => d.name);
    assert(missing.length === 0, 'dangling: ' + missing.join(', '));
  });
  t(key + ': every WP-11 reference doc for this file is linked from the core', () => {
    const want = frozen.docs.filter((n) => !linked.some((d) => d.name === n));
    assert(want.length === 0, 'not linked: ' + want.join(', '));
  });
  t(key + ': every pre-WP-11 heading/bold title is reachable from the core or a linked reference doc', () => {
    const missing = frozen.titles.filter((title) => !haystack.includes(normalizeWs(title)));
    assert(missing.length === 0, missing.length + ' title(s) lost:\n    - ' + missing.join('\n    - '));
  });
  t(key + ': every linked WP-11 doc keeps balanced verbatim markers', () => {
    for (const d of linked.filter((x) => frozen.docs.includes(x.name))) {
      const b = (d.text.match(/<!-- wp11-verbatim-begin /g) || []).length;
      const e = (d.text.match(/<!-- wp11-verbatim-end -->/g) || []).length;
      assert(b === 1 && e === 1, d.name + ': begin=' + b + ' end=' + e);
    }
  });
}

const forgeCore = fs.readFileSync(CORES.forge, 'utf8');
t('/forge core keeps the compaction-critical anchors (run contract recipe, scribe gate, hard gates, $ARGUMENTS)', () => {
  for (const needle of ['$ARGUMENTS', 'forge-runcontract.cjs plan --run', 'forge-scribe.cjs', 'gate --final',
    'Hard gates always interrupt', 'Project isolation', 'Honesty', 'GOAT routing', 'FORGE_MODEL_ROUTING.json']) {
    assert(forgeCore.includes(needle), 'missing: ' + needle);
  }
});
t('/forge core still links the four WP-C reference docs forge-md-coverage.test.cjs requires', () => {
  for (const n of ['paperclip.md', 'resume.md', 'learn-harvest.md', 'tournament-secondbrain-codemodel-briefing.md']) {
    assert(forgeCore.includes('.claude/docs/forge-reference/' + n), 'missing link: ' + n);
  }
});
const routerCore = fs.readFileSync(CORES.router, 'utf8');
t('router core keeps the Step 1 domain table as the first table after "## Step 1" (forge-audit-loop parses it)', () => {
  const i = routerCore.indexOf('## Step 1');
  assert(i !== -1, 'no "## Step 1" heading');
  const after = routerCore.slice(i);
  const next = after.slice(1).search(/\n## /);
  const section = next === -1 ? after : after.slice(0, next + 1);
  const rows = section.split(/\r?\n/).filter((l) => /^\s*\|/.test(l) && /`forge-[a-z0-9-]+`\s*\|\s*$/.test(l));
  assert(rows.length >= 20, 'expected >= 20 domain rows, got ' + rows.length);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
