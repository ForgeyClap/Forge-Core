'use strict';
/**
 * doctor/checks-hygiene.cjs — one module of forge-doctor.cjs (WP A11 part 2): skill_hygiene (progressive disclosure), installationProfile and the dev-tree marker.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { claudeDir, listByExt } = require('./context.cjs');
const { parseFrontmatter } = require('./checks-agents.cjs');
const { listSkillFiles } = require('./checks-completeness.cjs');

// ===========================================================================================================
// wp-disclosure-ab — progressive-disclosure hygiene as a doctor advisory (backlog item 12,
// YT-SWEEP-2026-07-31, 6 source videos: zKBPwDpBfhs, WMi0BLDLAjk, 7s9Fnorg3eI, HCwfRe5EHGQ, fOxC44g8vig,
// JN7QCdvJwwM — see .claude/forge-research/YT-SWEEP-2026-07-31.md item #12). Built on the forge-skill-evals.cjs
// FOUNDATION piece above (same ADVISORY-ONLY posture, same "a skill dir is scanned independently — one bad
// skill never crashes the whole check" discipline).
// ===========================================================================================================
const SKILL_DESCRIPTION_MAX_CHARS = 200; // the wp3b description-length budget law — see forge-skill-evals.cjs's
  // own `frontmatter_field` max_length for the SAME budget wired as a per-skill, opt-in, machine-checkable
  // assertion; this check applies it project-wide, unconditionally, to every skill.
const SKILL_BODY_MAX_LINES = 500; // this project's own CLAUDE.md file-size guidance ("Keep files under 500
  // lines"). Whole-file line count, frontmatter included — mirrors forge-skill-evals.cjs's own `max_lines`
  // assertion semantics (the frontmatter is only a few lines, a faithful proxy for "keep the body small").
const SKILL_CODE_SPAN_RE = /`([^`\n]+)`/g;
const LOCAL_ONLY_REF_RE = /^\.claude\/(forge-research|forge-runs)\//;
// W2-LOWS gap 1: a DIRECT child of a local-only folder (`.claude/forge-research/docdrift-state.json`) can be a
// runtime file our own code writes on every install; anything deeper (`.claude/forge-runs/<run>/events.jsonl`) names one
// maintainer's run or research folder and never exists on a fresh clone, so the generated-name exemption skips it.
const LOCAL_ONLY_DIRECT_CHILD_RE = /^\.claude\/(forge-research|forge-runs)\/[^/]+$/;
// 2026-11-07 (category tests F5b): the project memory files are per-project state. forge-sync install never creates
// them (the Lead's first scan writes them), so on every fresh install they are absent by design and a skill that tells
// the Lead to read them is not a broken link. Exact names directly under .claude/ only; a typo stays dangling.
const PROJECT_MEMORY_REF_RE = /^\.claude\/FORGE_(MEMORY|TASK_HISTORY|AGENT_LEDGER|DECISIONS|PROJECT_PROFILE)\.md$/;
const SKILL_PATH_SHAPE_RE = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/;
// Deliberately narrow anchor set — matches the work package's own two examples exactly: a fully-qualified
// project path from the repo root (".claude/...") or a skill's own tier-3 on-demand subfolder convention
// (references/ / scripts/ / assets/), resolved relative to the SKILL.md's own directory. A bare relative
// mention with NEITHER anchor (e.g. "docs/ARCHITECTURE.md", "src/contract.js" — real strings this project's
// own playbooks use to describe a DOWNSTREAM built project's OWN tree, never this Forge project's) is
// intentionally left unchecked: there is no safe, unambiguous base to resolve it against (project root? this
// project's .claude/? the skill's own folder?) — guessing one would fabricate a finding, not report one.
const SKILL_REF_WHITELIST_PREFIXES = ['.claude/', 'references/', 'scripts/', 'assets/'];

/** extractSkillPathRefs(text) -> [{ref, anchored}, ...] — every DISTINCT backtick-wrapped, path-shaped token
 *  in a SKILL.md body. ONLY scans inside backtick code-spans: a survey of every real file/tool reference
 *  across this project's actual 48 SKILL.md files found every genuine one already wrapped in
 *  backticks, and requiring the code-span boundary is what keeps this check from ever matching an ordinary
 *  prose sentence that happens to contain a slash and a period (a date, a fraction, an abbreviation) — the
 *  work package's own "no false positives on prose" requirement. Two further filters, both proven necessary
 *  against this project's real content:
 *   - a URL (http:// or https://) is stripped from the text before scanning, so a URL's own path segment
 *     (e.g. "github.com/owner/repo.git") is never mistaken for a project file reference.
 *   - an "alternation" token — e.g. "manifest.json/events.jsonl", real prose in this project meaning
 *     "manifest.json OR events.jsonl", never a nested directory — is detected (any segment BEFORE the last
 *     one that already looks like a complete "name.ext" on its own) and rejected; a genuine nested directory
 *     component in this codebase never itself has a bare "name.ext" shape.
 *  A candidate containing "<" (a placeholder like "<run_id>") or "*" (a glob, e.g.
 *  "config/orchestration/*.json") is never treated as a literal file, per the work package. `anchored` (see
 *  SKILL_REF_WHITELIST_PREFIXES above) marks whether this checker has a safe, unambiguous base to resolve
 *  the reference against; an unanchored candidate is returned but never existence-checked by skillHygiene()
 *  below — never a fabricated finding against a base this checker is only guessing at. Never throws. */
function extractSkillPathRefs(text) {
  const withoutUrls = text.replace(/https?:\/\/[^\s)`'"]+/g, '');
  const seen = new Set();
  const out = [];
  let m;
  SKILL_CODE_SPAN_RE.lastIndex = 0;
  while ((m = SKILL_CODE_SPAN_RE.exec(withoutUrls)) !== null) {
    const inner = m[1].trim();
    if (!SKILL_PATH_SHAPE_RE.test(inner)) continue;
    if (inner.includes('<') || inner.includes('*')) continue;
    if (seen.has(inner)) continue;
    const segs = inner.split('/');
    let altProse = false;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(segs[i])) { altProse = true; break; }
    }
    if (altProse) continue;
    seen.add(inner);
    out.push({ ref: inner, anchored: SKILL_REF_WHITELIST_PREFIXES.some((p) => inner.startsWith(p)) });
  }
  return out;
}

/**
 * detectVendorPin(text) -> {source, pin} | null — is this skill third-party content copied at a recorded pin?
 *
 * Provenance has to be EARNED, not claimed: BOTH an upstream `Source:` and a `Pinned commit:` hash. One line
 * on its own proves nothing, and if a single typed word could buy an exemption then "vendored" stops being
 * evidence and becomes a way to silence a check. Only the head of the file is read, because this must be a
 * header the vendoring step wrote — not a phrase that happens to appear in 600 lines of prose.
 */
function detectVendorPin(text) {
  const head = String(text || '').slice(0, 4000);
  const source = head.match(/^[\s*/#-]*Source:\s*(\S+)/m);
  const pin = head.match(/^[\s*/#-]*Pinned commit:\s*([0-9a-f]{7,40})\b/im);
  if (!source || !pin) return null;
  return { source: source[1], pin: pin[1] };
}

/** generatedPathBasenames(root) -> Set<'naam.ext'> — bestandsnamen die onze EIGEN code wegschrijft.
 *
 *  MEASURED FALSE POSITIVE (echte doctor-run): `skill-hygiene: forge-snapshot (1 dangling
 *  reference(s): .claude/.forge-snapshot-due.json)`. Dat bestand wordt door forge-snapshot-marker.cjs
 *  GESCHREVEN en door de SessionStart-hook geconsumeerd — afwezig zijn is zijn normale toestand. Je eigen
 *  outputpad documenteren is geen kapotte link, en een advisory die volloopt met valse positieven wordt
 *  niet meer gelezen — precies zo mist hij straks een ECHTE dangling reference.
 *
 *  Bewust op BASENAME: de schrijvende code stelt het pad samen (`path.join(dueDir, '.forge-snapshot-due.json')`),
 *  dus het volledige pad bestaat nergens als literal. Om dat niet te laten ontsporen tot "elke bestandsnaam
 *  die ergens in een schrijvend bestand voorkomt", tellen alleen literals op (of vlak onder) een regel met een
 *  echte schrijf-API. Testbestanden tellen niet mee: fixtures schrijven van alles en zijn geen bron van waarheid. */
const WRITE_API_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\b/;
const FILENAME_LITERAL_RE = /['"`](\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]/g;
// The write call and its argument list on one line: `fs.writeFileSync(projMarkerPath, json, 'utf8')` ->
// group 1 = api, group 2 = everything up to the first `)`. Used to find WHICH variable is being written.
const WRITE_CALL_ARGS_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\s*\(([^()]*)/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
function generatedPathBasenames(root) {
  const out = new Set();
  for (const sub of ['forge-bin', 'forge-dashboard', 'hooks']) {
    let files = [];
    try { files = listByExt(path.join(claudeDir(root), sub), ['.cjs', '.mjs', '.js']); } catch { continue; }
    for (const f of files) {
      if (/\.test\.(cjs|mjs|js)$/.test(f)) continue;
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { continue; }
      const resolved = new Set(); // one declaration lookup per written variable per file
      for (let i = 0; i < lines.length; i++) {
        if (!WRITE_API_RE.test(lines[i])) continue;
        const window = lines[i] + '\n' + (lines[i + 1] || ''); // een gewrapte aanroep zet het pad op de volgende regel
        FILENAME_LITERAL_RE.lastIndex = 0;
        let m;
        while ((m = FILENAME_LITERAL_RE.exec(window)) !== null) out.add(m[1]);
        harvestPathHelpers(window, lines, out); // `appendFileSync(ledgerPath(root), …)` — the path comes from a helper
        // 2026-09-23 (measured on forge-setup.cjs, restored this release): the path is often built ONCE into a
        // variable — `const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json')` — and the
        // write, fifteen lines later, only names that variable: `fs.writeFileSync(projMarkerPath, …)`. Neither
        // line carries both the write API and the literal, so the marker fell through and forge-router's honest
        // reference to `.claude/.forge-setup.json` came back as a "dangling" link. Resolve the written argument
        // (the first one; for copyFileSync the second — that is the destination) to its declaration in the SAME
        // file — const/let/var, one hop, no re-assignment chasing — and take the literals from that line. Still
        // bounded: only a variable that is actually handed to a write API is ever looked up.
        const call = WRITE_CALL_ARGS_RE.exec(lines[i]);
        if (!call) continue;
        const args = call[2].split(',').map((a) => a.trim());
        const written = call[1] === 'copyFileSync' ? args[1] : args[0];
        if (!written || !IDENTIFIER_RE.test(written) || resolved.has(written)) continue;
        resolved.add(written);
        const declRe = new RegExp('\\b(?:const|let|var)\\s+' + written.replace(/\$/g, '\\$') + '\\s*=');
        for (let j = 0; j < lines.length; j++) {
          if (!declRe.test(lines[j])) continue;
          const declWindow = /[;}]\s*$/.test(lines[j]) ? lines[j] : lines[j] + '\n' + (lines[j + 1] || ''); // same spill rule as the helper hop
          FILENAME_LITERAL_RE.lastIndex = 0;
          let d;
          while ((d = FILENAME_LITERAL_RE.exec(declWindow)) !== null) out.add(d[1]);
          harvestPathHelpers(declWindow, lines, out);
        }
      }
    }
  }
  return out;
}
/** One more hop, still bounded: a written path is often produced by a small helper — `appendFileSync(ledgerPath(root), …)`
 *  or `const statePath = opts.statePath || defaultStatePath(root)` with `function defaultStatePath(root) { return
 *  path.join(root, '.claude', 'forge-research', 'docdrift-state.json'); }`. Measured on every fresh install's doctor
 *  (CI): forge-docdrift and forge-router were flagged for exactly such helper-built paths. Only identifiers
 *  that are CALLED in the write/declaration window are looked up, and only their own `function NAME(` line (+1). */
function harvestPathHelpers(window, lines, out) {
  const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const SKIP = new Set(['require', 'writeFileSync', 'appendFileSync', 'writeAtomic', 'createWriteStream', 'copyFileSync', 'join', 'resolve', 'stringify', 'parse', 'push', 'toString', 'String', 'Number', 'if', 'for', 'while', 'catch', 'function', 'Error', 'JSON']);
  let c;
  while ((c = CALL_RE.exec(window)) !== null) {
    const name = c[1];
    if (SKIP.has(name)) continue;
    const fnRe = new RegExp('\\bfunction\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    for (let k = 0; k < lines.length; k++) {
      if (!fnRe.test(lines[k])) continue;
      // Only spill onto the next line when this one is genuinely unfinished (a wrapped `return path.join(…,`); a
      // one-line helper ending in `}` must not harvest the NEXT helper's literal (measured: a never-called decoy
      // helper on the following line was classified as generated).
      const fnWindow = /[;}]\s*$/.test(lines[k]) ? lines[k] : lines[k] + '\n' + (lines[k + 1] || '');
      FILENAME_LITERAL_RE.lastIndex = 0;
      let d;
      while ((d = FILENAME_LITERAL_RE.exec(fnWindow)) !== null) out.add(d[1]);
    }
  }
}

/** skillHygiene(root) -> {ok, checked, vendored_exempt, skills:[{skill, ok, issues:[], vendored?, vendored_style?, generated_refs?}]}
 *  ADVISORY-ONLY (see header doc).
 *  Unlike skill_evals above (opt-in evals.json), EVERY skill dir under .claude/skills/ that has a SKILL.md
 *  is IN SCOPE here — there is no opt-out.
 *
 *  SCOPE DEFECT FIXED 2026-08-01 (measured on this project, not assumed): this function used to do its own
 *  single-level `readdirSync(skills/)` + `<dir>/SKILL.md` read, i.e. exactly a one-star `skills/<x>/SKILL.md`
 *  glob — which found 49 of this project's 57 real SKILL.md files. The 8 gsap sub-skills live one level deeper
 *  (`skills/gsap/gsap-core/SKILL.md` …) and were therefore evaluated by NOTHING: not passing, INVISIBLE,
 *  which is strictly worse than a red finding — and every one of them is over the description budget this
 *  check exists to police, i.e. the check was blind to precisely the surface it was written for. It now
 *  reuses listSkillFiles() (already defined and exported above for sync_completeness), the one recursive
 *  SKILL.md walker in this file — so the hygiene scope and the sync-manifest scope can never drift apart
 *  again. `skill` is the skills/-relative id ("gsap/gsap-core"), never a bare leaf name two bundles could
 *  both claim. Three checks per skill: (1) frontmatter `description` present
 *  and <= SKILL_DESCRIPTION_MAX_CHARS; (2) whole-file line count <= SKILL_BODY_MAX_LINES; (3) every
 *  ANCHORED path-shaped reference (extractSkillPathRefs above) resolves to a real file — a `.claude/`-
 *  prefixed ref resolves from the project root, everything else (references//scripts//assets/) resolves
 *  from the SKILL.md's OWN directory. Check (3) covers the SKILL.md AND every *.md under the skill's own
 *  references/ folder (WP 2.9) and the skill's learnings.md (W2-LOWS), with the same resolution. A skill dir with no SKILL.md is out of scope (mirrors
 *  listSkillDirs()'s own opt-in-by-file-presence posture in forge-skill-evals.cjs — not a skill, not
 *  evaluated). Never throws: an unreadable SKILL.md is simply excluded from `checked`, never crashes the
 *  whole scan (one bad skill dir must never take down every other skill's report). NOT promoted to
 *  ENFORCED: same reasoning as skill_evals — this is advisory review signal for the Skill Boss today, not
 *  yet a build gate. */
/** listSkillReferenceDocs(skillDir) -> sorted absolute paths of every *.md under <skillDir>/references/ (any
 *  depth). [] when there is none. Never throws (an unreadable folder is skipped). */
function listSkillReferenceDocs(skillDir) {
  const out = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
    }
  })(path.join(skillDir, 'references'));
  return out.sort();
}
function skillHygiene(root) {
  const cd = claudeDir(root);
  const skills = [];
  const generatedNames = generatedPathBasenames(root); // één keer scannen, niet per skill
  for (const rel of listSkillFiles(root)) {
    const skillFile = path.join(cd, rel.split('/').join(path.sep));
    const skillDir = path.dirname(skillFile);
    // skills/-relative id, so a nested skill is named the way it is actually addressed on disk
    // ("gsap/gsap-core"), never collapsed to a bare leaf name that two bundles could both claim.
    const skillId = rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '');
    let text;
    try { text = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
    const issues = [];
    // VENDORED CONTENT. A skill copied verbatim from an upstream repo at a recorded pin is not
    // ours to restyle: rewriting it would make the pin describe something no longer on disk. So its SHAPE
    // (description/body length) is reported separately, with the real numbers, while its FUNCTION in our
    // tree (a usable description, references that resolve) is judged exactly like anything else. See the
    // vendored fixtures in forge-doctor.test.cjs §7 for why a half-marker must not buy this exemption.
    const vendored = detectVendorPin(text);
    const vendoredStyle = [];
    const styleIssue = (msg) => (vendored ? vendoredStyle : issues).push(msg);
    const fm = parseFrontmatter(text);
    const desc = fm && fm.description;
    if (!desc) issues.push('description missing/empty in frontmatter'); // no description = undiscoverable HERE, never upstream's problem to own
    else if (desc.length > SKILL_DESCRIPTION_MAX_CHARS) styleIssue('description is ' + desc.length + ' chars (max ' + SKILL_DESCRIPTION_MAX_CHARS + ')');
    const lineCount = text.split(/\r?\n/).length;
    if (lineCount > SKILL_BODY_MAX_LINES) styleIssue('SKILL.md is ' + lineCount + ' lines (max ' + SKILL_BODY_MAX_LINES + ')');
    const dangling = [];
    const generatedRefs = [];
    const optionalRefs = [];
    // 2026-10-24 (modernization WP 2.9): the skill's own references/**/*.md are part of the skill (progressive
    // disclosure: WP 2.4a/2.4b moved SKILL.md body text there), so their anchored references are checked too,
    // resolved exactly like the SKILL.md's. Without this, text moved out of a SKILL.md left the check blind to
    // it (forge-doctor.test.cjs skillHygiene (c)/(d) caught that on the real tree). A dangling ref found there
    // names its file; a ref already reported from the SKILL.md is not listed twice.
    const sources = [{ text, from: null }];
    // W2-LOWS gap 2: the skill's own learnings.md ships with it and is read before every use of the skill,
    // so its links are judged like the SKILL.md's (three skills kept links into forge-research there).
    const learnings = path.join(skillDir, 'learnings.md');
    for (const f of listSkillReferenceDocs(skillDir).concat(fs.existsSync(learnings) ? [learnings] : [])) {
      try { sources.push({ text: fs.readFileSync(f, 'utf8'), from: path.relative(skillDir, f).split(path.sep).join('/') }); } catch { /* unreadable doc: skipped, like an unreadable SKILL.md */ }
    }
    const pushOnce = (list, v, fromDoc) => { if (!fromDoc || !list.includes(v)) list.push(v); };
    for (const src of sources) for (const r of extractSkillPathRefs(src.text)) {
      if (!r.anchored) continue;
      const resolved = r.ref.startsWith('.claude/') ? path.resolve(root, r.ref) : path.resolve(skillDir, r.ref);
      let exists = false;
      try { exists = fs.statSync(resolved).isFile(); } catch { exists = false; }
      // .claude/forge-research/ and .claude/forge-runs/ are gitignored and never shipped. A link there
      // resolves on the maintainer's machine and dangles on every fresh clone (a clean worktree proved it), so it
      // counts as dangling even when the file exists here — unless our own code writes it (generated, below).
      const localOnly = LOCAL_ONLY_REF_RE.test(r.ref);
      if (exists && !localOnly) continue;
      // afwezig én door onze eigen code geschreven = runtime-marker, geen kapotte link. Herclassificeren,
      // niet verzwijgen: hij blijft zichtbaar onder generated_refs zodat de informatie niet verdwijnt.
      // W2-LOWS gap 1: never for a local-only ref below a direct child (one run's or one research folder's file).
      if (generatedNames.has(path.basename(r.ref)) && (!localOnly || LOCAL_ONLY_DIRECT_CHILD_RE.test(r.ref))) pushOnce(generatedRefs, r.ref, src.from);
      // convention: `*.user.json` is a PRIVATE user-state file (owner rules, scout verdicts, the Codex
      // pin, a bench baseline) — never shipped, never synced, created only when the user needs it. A skill
      // documenting where it lives is not a broken link: it is absent on every fresh install by design (the
      // maintainer's own machine has one, which is exactly how "works here, fails on the laptop" happened).
      // Reclassified, not hidden: it stays visible under optional_refs.
      else if (/\.user\.json$/i.test(r.ref)) pushOnce(optionalRefs, r.ref, src.from);
      // 2026-11-07 (category tests F5b): see PROJECT_MEMORY_REF_RE — absent on every fresh install by design.
      else if (!exists && PROJECT_MEMORY_REF_RE.test(r.ref)) pushOnce(optionalRefs, r.ref, src.from);
      else dangling.push((src.from ? r.ref + ' (in ' + src.from + ')' : r.ref) + (exists && localOnly ? ' [local-only folder, not shipped]' : ''));
    }
    if (dangling.length) issues.push(dangling.length + ' dangling reference(s): ' + dangling.join(', '));
    const entry = { skill: skillId, ok: issues.length === 0, issues };
    if (generatedRefs.length) entry.generated_refs = generatedRefs;
    if (optionalRefs.length) entry.optional_refs = optionalRefs;
    if (vendored) { entry.vendored = vendored; entry.vendored_style = vendoredStyle; }
    skills.push(entry);
  }
  return {
    ok: skills.every((s) => s.ok),
    checked: skills.length,
    vendored_exempt: skills.filter((s) => s.vendored && s.vendored_style.length).length,
    skills,
  };
}

/**
 * installationProfile(root) -> {profile:'development'|'redistribution', marker, marker_present, vendored:[ids],
 *   checked, reason}
 *
 * DISCRIMINATOR CHANGED: the verdict now keys on `.claude/config/forge-dev-tree.json` (a
 * parseable `{"dev_tree": true}`), NOT on "carries vendored skills". The history below explains why vendoring
 * was once a sound marker; it stopped being one the day the public distribution began SHIPPING vendored skills
 * (13 obra/superpowers skills + frontend-design): a fresh clone would then read as the development tree
 * and run exact-count assertions against a tree that honestly holds fewer skills. The marker file is the
 * difference that survives: it exists only in the canonical checkout and the release sync deliberately never
 * ships it. The vendoring pins are still counted and quoted in `reason`, because a skip must be able to say
 * what it saw. The two profile names are kept unchanged on purpose — forge-configdrift.test.cjs and
 * forge-contextbudget.test.cjs gate on `profile === 'development'`.
 *
 * WHICH TREE IS THIS? — not a check, and deliberately never folded into any verdict. It answers
 * one narrow question that some assertions genuinely need to ask before they mean anything: is this the
 * canonical development tree, or a redistribution of it?
 *
 * The problem it exists to solve: several tests pin an EXACT property of this installation ("this project
 * has exactly 57 skills"). Those pins are real drift guards here — they are how a silently-dropped skill or
 * a walk that stops one directory too shallow gets caught. In the published distribution the same pins fail
 * for a reason that is not a defect: the 9 vendored third-party skills are deliberately not redistributed,
 * so the tree honestly has fewer. Loosening the pins to a range, or listing the acceptable counts, would
 * destroy exactly the drift detection they were written for — a count that accepts two answers guards
 * nothing.
 *
 * (Historical, 2026-08-02 until wp17 — superseded by the dev-tree marker above.) The marker WAS the
 * difference itself: a skill counts as vendored only when detectVendorPin() finds BOTH an upstream `Source:`
 * and a `Pinned commit:` hash that the vendoring step actually wrote into the file, and a tree without any
 * such skill was treated as a redistribution. What remains true: a pinned assertion outside the development
 * tree is a SKIP with a stated reason, never a quiet pass.
 *
 * Deliberately NOT a doctor check and NOT in `checks`: neither profile is a defect. Never throws — an
 * unreadable skill is simply not counted, exactly as skillHygiene() treats it.
 */
const DEV_TREE_MARKER_REL = '.claude/config/forge-dev-tree.json';
/** readDevTreeMarker(root) -> {present, valid, error?} — the marker counts only when it parses AND says
 *  `dev_tree: true`; an empty or garbled file is reported, never promoted to "development". Never throws. */
function readDevTreeMarker(root) {
  const p = path.join(claudeDir(root), 'config', 'forge-dev-tree.json');
  if (!fs.existsSync(p)) return { present: false, valid: false };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && data.dev_tree === true ? { present: true, valid: true } : { present: true, valid: false, error: 'dev_tree is not true' };
  } catch (e) { return { present: true, valid: false, error: e.code || e.name }; }
}
function installationProfile(root) {
  const cd = claudeDir(root);
  const vendored = [];
  let checked = 0;
  for (const rel of listSkillFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(cd, rel.split('/').join(path.sep)), 'utf8'); } catch { continue; }
    checked++;
    if (detectVendorPin(text)) vendored.push(rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, ''));
  }
  const marker = readDevTreeMarker(root);
  const dev = marker.valid;
  const pins = vendored.length + ' of ' + checked + ' skills carry an upstream Source: + Pinned commit: header';
  return {
    profile: dev ? 'development' : 'redistribution',
    marker: DEV_TREE_MARKER_REL,
    marker_present: marker.present,
    vendored: vendored.sort(),
    checked,
    reason: dev
      ? 'development tree: ' + DEV_TREE_MARKER_REL + ' present (' + pins + ')'
      : marker.present
        ? 'not the development tree: ' + DEV_TREE_MARKER_REL + ' exists but is not a valid {"dev_tree": true} marker (' + marker.error + '); ' + pins
        : 'not the development tree: ' + DEV_TREE_MARKER_REL + ' (the canonical-checkout marker the release sync never ships) is absent, so the exact counts measured in the development tree do not apply; ' + pins,
  };
}

module.exports = { LOCAL_ONLY_REF_RE, LOCAL_ONLY_DIRECT_CHILD_RE, PROJECT_MEMORY_REF_RE,
  SKILL_DESCRIPTION_MAX_CHARS, SKILL_BODY_MAX_LINES, SKILL_CODE_SPAN_RE, SKILL_PATH_SHAPE_RE,
  SKILL_REF_WHITELIST_PREFIXES, extractSkillPathRefs, detectVendorPin, WRITE_API_RE, FILENAME_LITERAL_RE,
  WRITE_CALL_ARGS_RE, IDENTIFIER_RE, generatedPathBasenames, harvestPathHelpers, listSkillReferenceDocs,
  skillHygiene, DEV_TREE_MARKER_REL, readDevTreeMarker, installationProfile,
};
