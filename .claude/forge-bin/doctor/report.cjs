'use strict';
/**
 * doctor/report.cjs — one module of forge-doctor.cjs (WP A11 part 2): printSummary: the human-readable doctor report.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const { contextBudgetTool } = require('./context.cjs');
const { runContractSummary } = require('./checks-runs.cjs');
const { PLUGIN_DIST_REL } = require('./checks-advisory.cjs');
const { timingLabel } = require('./checks-adapters.cjs');
const { toolSummaryLines } = require('./checks-tools.cjs');

function printSummary(rep) {
  const c = rep.checks;
  // a label of 16+ characters still gets one space before its detail (was "release exclusions8 sync_folders")
  const line = (label, ok, detail) => (ok ? '  ✓ ' : '  ✗ ') + (label.length >= 16 ? label + ' ' : label.padEnd(16)) + (detail || '');
  const out = [];
  out.push('Forge Doctor — ' + rep.root);
  out.push(line('node --check', c.node_check.ok, c.node_check.total + ' files' + (c.node_check.ok ? '' : ' · ' + (c.node_check.reason || (c.node_check.failed + ' FAILED')))));
  // 2026-09-24 (measured on the first CI run): "122 suites · 6128 passed / 0 failed · 1 SUITE(S) FAILED" named
  // NOTHING — a suite that crashed before its tally (0 failed assertions, non-zero exit) was invisible on a runner
  // where nobody can open the per-suite output. Name the red suites, with WHY (crashed / no tally / timeout).
  const redSuites = Array.isArray(c.tests.perSuite) ? c.tests.perSuite.filter((s) => s && s.ok === false) : [];
  const whySuite = (s) => s.timedOut ? 'timeout' : (s.passed === 0 && s.failed === 0 ? 'crashed or no tally' : (s.failed > 0 ? s.failed + ' failed' : 'non-zero exit'));
  const redNames = redSuites.slice(0, 6).map((s) => s.suite + ' (' + whySuite(s) + ')').join(', ') + (redSuites.length > 6 ? ', +' + (redSuites.length - 6) + ' more' : '');
  out.push(line('tests', c.tests.ok, c.tests.suites + ' suites · ' + c.tests.passed + ' passed / ' + c.tests.failed + ' failed'
    + (c.tests.ok ? '' : ' · ' + (c.tests.reason || [c.tests.suitesFailed ? c.tests.suitesFailed + ' SUITE(S) FAILED' : '', c.tests.suitesBlocked ? c.tests.suitesBlocked + ' SUITE(S) BLOCKED (timeout)' : ''].filter(Boolean).join(' · ')) + (redNames ? ' → ' + redNames : ''))));
  out.push(line('honesty gate', c.strict_events.ok, 'known accepted=' + c.strict_events.known_accepted + ' · unknown rejected=' + c.strict_events.unknown_rejected));
  // 2026-09-23 (external audit II-G): this line used to read "dashboard SPA · 7 files present", which a
  // new user reads as "the dashboard works" — but these seven files are the RETIRED per-project Control
  // Center that is never started; the live Command Center is a separate build. Say what is actually being
  // checked, so a green here is never mistaken for a working dashboard.
  out.push(line('legacy SPA files', c.dashboard_spa.ok, c.dashboard_spa.present.length === 0
    ? 'none present — retired Control Center removed in 2.9.0 (log-event.cjs stays; the dashboard is the Command Center)'
    : c.dashboard_spa.present.length + ' legacy file(s) still present (advisory only — forge-sync install removes them when unmodified): ' + c.dashboard_spa.present.join(', ')));
  const lk = c.leak_scan;
  // MULTI-REPO ACCOUNTING: when more than one repository under this root contributed files,
  // say so and say how many each gave. A single anonymous total is exactly what let "1146 tracked files ·
  // clean" stand for years while a whole nested tree was never opened. Appended ONLY when there really is
  // more than one source, so an ordinary single-repo project's line is unchanged, character for character.
  const lkSources = lk.sources || [];
  const lkFrom = lkSources.length > 1
    ? ' from ' + lkSources.length + ' repos: ' + lkSources.map((s) => s.root + ' ' + (s.unavailable ? 'UNAVAILABLE (' + s.unavailable + ')' : s.files)).join(' + ')
    : '';
  const lkSkips = lk.skipped || [];
  const lkTooLarge = lkSkips.filter((s) => s.reason === 'too-large').length;
  const lkBinary = lkSkips.filter((s) => s.reason === 'binary').length;
  const lkUnreadable = lkSkips.filter((s) => s.reason === 'unreadable').length;
  const lkLongLine = lkSkips.filter((s) => s.reason === 'long-line').length;
  // honest coverage note (4th/5th fix round): never let the verdict imply total coverage while something was
  // dropped. too-large/binary/unreadable = the WHOLE file was not scanned (all honesty-critical — a real
  // secret could hide there); long-line = the file WAS scanned except over-long lines were length-bounded
  // (ReDoS guard). All surfaced so "clean" never silently means "clean among only what we bothered to scan".
  const lkParts = [];
  const lkNotScanned = lkTooLarge + lkBinary + lkUnreadable;
  if (lkNotScanned) lkParts.push(lkNotScanned + ' file(s) not scanned (' + [lkTooLarge ? lkTooLarge + ' too-large' : '', lkBinary ? lkBinary + ' binary' : '', lkUnreadable ? lkUnreadable + ' unreadable' : ''].filter(Boolean).join(', ') + ')');
  if (lkLongLine) lkParts.push(lkLongLine + ' file(s) with over-long line(s) bounded');
  // WP-SYNC-R8: a folder deliberately not descended into is NAMED (only when there is one — an ordinary line is unchanged)
  if ((lk.notScanned || []).length) lkParts.push('not scanned: ' + lk.notScanned.map((n) => n.dir + '/').join(', ') + ' (agent worktree checkouts)');
  const lkSkip = lkParts.length ? ' · ' + lkParts.join(' · ') : '';
  out.push(line('leak scan', lk.ok, lk.scanned + ' tracked files (' + lk.source + ')' + lkFrom + (lk.ok ? ' · clean' : ' · ' + lk.hits.length + ' HIT(S): ' + lk.hits.map((h) => h.pattern + ' in ' + h.file).join('; ')) + lkSkip));
  if (c.agents) {
    const a = c.agents;
    const tp = a.toolPolicy || {};
    const tpBad = tp.ok === false ? [
      tp.reason || '',
      (tp.missingPolicy || []).length ? 'no policy entry: ' + tp.missingPolicy.join(',') : '',
      (tp.missingAgentFile || []).length ? 'policy entry but no agent-md: ' + tp.missingAgentFile.join(',') : '',
      (tp.classViolations || []).length ? 'POLICY ITSELF violates class rules: ' + tp.classViolations.map((v) => v.agent + '(' + v.forbidden.join(',') + ')').join('; ') : '',
      (tp.driftViolations || []).length ? 'TOOL-GRANT DRIFT: ' + tp.driftViolations.map((v) => v.agent + (v.extra.length ? ' +' + v.extra.join(',') : '') + (v.missing.length ? ' -' + v.missing.join(',') : '')).join('; ') : '',
      (tp.overlayProblems || []).length ? 'OVERLAY REJECTED (agent-tool-policy.user.json may only add agents): ' + tp.overlayProblems.join('; ') : '',
    ].filter(Boolean).join(' · ') : '';
    const overlayNote = (tp.overlayAdded || []).length ? ' (+' + tp.overlayAdded.length + ' project agent(s) from agent-tool-policy.user.json: ' + tp.overlayAdded.join(', ') + ')' : '';
    // WP 1.5: the generated agents file (frontmatter = source of truth) — named on the ✓ line, first violations on ✗
    const gen = a.generated || null;
    const genNote = gen && gen.applicable ? ' · generated config in sync (' + gen.checked + ' agents)' : '';
    const genViol = gen && gen.violations ? gen.violations : [];
    const genBad = gen && gen.ok === false ? 'GENERATED CONFIG DRIFT: ' + (genViol.length ? genViol.length + ' violation(s): ' + genViol.slice(0, 4).map((x) => x.kind + ' (' + x.detail + ')').join('; ') + (genViol.length > 4 ? '; +' + (genViol.length - 4) + ' more' : '') : (gen.reason || '')) + ' — fix the frontmatter, then node .claude/forge-bin/forge-registry-gen.cjs agents --write' : '';
    const detail = a.ok ? (a.expected + '/' + a.expected + ' Boss files · ' + a.found + ' agents · frontmatter valid · injection-clean · tool-policy clean' + overlayNote + genNote)
      : ([a.missing.length ? 'missing: ' + a.missing.join(',') : '', a.badFrontmatter.length ? 'bad frontmatter: ' + a.badFrontmatter.join(',') : '', a.injection.length ? 'INJECTION: ' + a.injection.map((h) => h.pattern + ' in ' + h.file).join('; ') : '', (a.unloadableModel || []).length ? 'NOT LOADABLE by Claude Code (model must be opus/sonnet/haiku/fable/inherit): ' + a.unloadableModel.map((u) => u.agent + '=' + u.model).join(', ') : '', tpBad, genBad].filter(Boolean).join(' · '));
    out.push(line('agents', a.ok, detail));
  }
  if (c.chain) {
    const ch = c.chain;
    out.push(line('event chain', ch.ok, ch.chained + '/' + ch.checked + ' runs hash-chained · tamper-evident' + (ch.ok ? '' : ' · BROKEN: ' + ch.broken.map((b) => b.run + ' (' + b.reason + ')').join('; '))));
  }
  if (c.rebinding_guard) out.push(line('rebind guard', c.rebinding_guard.ok, c.rebinding_guard.applicable === false ? c.rebinding_guard.reason : (c.rebinding_guard.ok ? 'Command Center gateway Host/Origin/Sec-Fetch guard wired' : c.rebinding_guard.reason)));
  // V9-INTEGRATE: the two completeness checks promoted from advisory to ENFORCED — printed as
  // ordinary ✓/✗ lines like every other checks-key above (they now genuinely gate `ok`). An `overridden:true`
  // result still prints ✓ (it IS a pass — see applyDoctorOverride() doc) but carries a visible
  // `[OVERRIDDEN: <reason>]` tag so an owner override is never mistaken for an ordinary clean pass.
  const overrideTag = (r) => r.overridden ? ' [OVERRIDDEN by ' + (r.override_by || 'owner') + ': ' + r.override_reason + ']' : '';
  if (c.unregistered_event) {
    const ue = c.unregistered_event;
    out.push(line('unreg. events', ue.ok, (ue.ok && !ue.overridden ? (ue.checkedFiles || 0) + ' files scanned · none unregistered' : (ue.unregistered && ue.unregistered.length ? ue.unregistered.length + ' unregistered usage(s): ' + ue.unregistered.map((u) => u.event_type + ' in ' + u.file).join('; ') : (ue.reason || ''))) + overrideTag(ue)));
  }
  if (c.check_the_checks) {
    const ctc = c.check_the_checks;
    out.push(line('no-op tests', ctc.ok, (ctc.ok && !ctc.overridden ? (ctc.checked || 0) + ' suites scanned · no green no-ops' : (ctc.noOp && ctc.noOp.length ? ctc.noOp.length + ' green no-op suite(s): ' + ctc.noOp.map((n) => n.suite).join(', ') : '')) + overrideTag(ctc)));
  }
  // (prd-w2-discipline M2): release_exclusions — see releaseExclusionsCheck()'s own
  // doc for exactly what "dist check skipped" means and why it is not a problem.
  if (c.release_exclusions) {
    const re = c.release_exclusions;
    const pc = re.pattern_counts;
    const countsText = pc ? pc.sync_folders + ' sync_folders · ' + pc.never_sync + ' never_sync · ' + pc.dist_forbidden + ' dist_forbidden pattern(s)' : '';
    const detail = re.ok && !re.overridden
      ? (re.dist_checked ? (re.files_checked || 0) + ' tracked file(s) checked via ' + re.method + ' · clean · ' + countsText : countsText + ' · ' + re.reason)
      : (re.reason || '');
    out.push(line('release exclusions', re.ok, detail + overrideTag(re)));
  }
  if (c.model_routing) {
    const mr = c.model_routing;
    const viol = mr.violations || [];
    const detail = mr.applicable === false ? 'n/a — ' + mr.reason
      : (mr.ok && !mr.overridden
        ? mr.checked + ' agent(s): frontmatter == agent-model-map == tool-policy · routes complete · escalate=fable · no env/settings override'
        : (viol.length ? viol.length + ' violation(s): ' + viol.slice(0, 4).map((v) => v.kind + ' (' + v.detail + ')').join('; ') + (viol.length > 4 ? '; +' + (viol.length - 4) + ' more' : '') : (mr.reason || '')))
      + ((mr.notes || []).length ? ' · note: ' + mr.notes.join(' · ') : '');
    out.push(line('model routing', mr.ok, detail + overrideTag(mr)));
  }
  // ship_manifest — known-gap warnings are named with their owner WP on the ✓ line itself, so a
  // green line never hides that real gaps are still open; a ✗ names the first violations.
  if (c.ship_manifest) {
    const sm = c.ship_manifest;
    const fl = sm.failures || [];
    const gapCounts = {};
    for (const w of sm.warnings || []) { const k = w.known_gap + '→' + w.owner_wp; gapCounts[k] = (gapCounts[k] || 0) + 1; }
    const gapText = Object.keys(gapCounts).length ? ' · known-gap warnings: ' + Object.entries(gapCounts).map(([k, n]) => k + ' ×' + n).join(', ') : '';
    const staleText = (sm.stale_known_gaps || []).length ? ' · STALE known gaps (remove them): ' + sm.stale_known_gaps.join(', ') : '';
    const detail = sm.applicable === false && sm.ok ? 'n/a — ' + sm.reason
      : (sm.ok && !sm.overridden
        ? (sm.sources || 0) + ' source paths classified (' + Object.entries(sm.by_class || {}).map(([k, n]) => k + ' ' + n).join(', ') + ') · sync drift both ways · ' + (sm.refs_checked || 0) + ' references closed' + gapText + staleText
        : (fl.length ? fl.length + ' violation(s): ' + fl.slice(0, 4).map((f) => f.kind + ' ' + f.path).join('; ') + (fl.length > 4 ? '; +' + (fl.length - 4) + ' more' : '') : (sm.reason || '')));
    out.push(line('ship manifest', sm.ok, detail + overrideTag(sm)));
  }
  // run_contract, ENFORCED — names the run, its state and (for a red) the exact next command.
  if (c.run_contract) out.push(line('run contract', c.run_contract.ok, runContractSummary(c.run_contract) + overrideTag(c.run_contract)));
  // feature_registry, ENFORCED in the development tree — counts on a ✓, exact names + the fix on a ✗.
  if (c.feature_registry) {
    const fr = c.feature_registry;
    const cnt = (k) => (fr.counts && fr.counts[k] ? fr.counts[k].wired + ' wired / ' + fr.counts[k]['on-request'] + ' on-request / ' + fr.counts[k].dormant + ' dormant' : '');
    const warn = [(fr.stale || []).length ? (fr.stale.length + ' stale classification(s) — regenerate') : '', (fr.dormant_without_note || []).length ? fr.dormant_without_note.length + ' dormant without a note' : '', (fr.unverifiable || []).length ? fr.unverifiable.length + ' unverifiable here (command-center/ absent)' : ''].filter(Boolean).join(' · ');
    const detail = fr.applicable === false ? 'n/a — ' + fr.reason
      : (fr.ok && !fr.overridden ? (fr.entries || 0) + ' entries · tools ' + cnt('tool') + ' · skills ' + cnt('skill') + (warn ? ' · ' + warn : '')
        : fr.reason + (fr.fix ? ' · fix: ' + fr.fix : ''));
    out.push(line('feature registry', fr.ok, detail + overrideTag(fr)));
  }
  // part ii: skill_frontmatter, ENFORCED in the development tree; outside it the findings are still printed.
  if (c.skill_frontmatter) {
    const sf = c.skill_frontmatter;
    // SA-P1-SKILLS: a broken enabled plugin is never hidden behind the clean text; name-vs-folder warnings are appended.
    const clean = (sf.failing || []).length === 0 && !(sf.applicable && sf.catalog && sf.catalog.applicable && !sf.catalog.checked) && !(sf.plugins && sf.plugins.ok === false);
    const sfWarn = (sf.warnings || []).length ? ' · WARN ' + sf.warnings.length + ' name/folder mismatch(es): ' + sf.warnings.slice(0, 3).join('; ') + (sf.warnings.length > 3 ? '; +' + (sf.warnings.length - 3) + ' more' : '') : '';
    // Rework 2026-11-04: say visibly whether the enabled-plugin install guard ran, and name switched-off plugins whose install is gone.
    const pl = sf.plugins || null;
    const plTag = pl && pl.applicable && pl.ok !== false ? ' · ' + (pl.enabled || []).length + ' enabled plugin(s) installed' : '';
    const plWarn = pl && (pl.warnings || []).length ? ' · WARN ' + pl.warnings.length + ' switched-off plugin(s) with a missing install: ' + (pl.disabled_stale || []).slice(0, 3).join(', ') + ((pl.disabled_stale || []).length > 3 ? ', +' + (pl.disabled_stale.length - 3) + ' more' : '') : '';
    const detail = (clean ? (sf.checked || 0) + ' skill(s) · frontmatter readable · descriptions quoted where needed · forge-* skills catalogued' + plTag + (sf.applicable ? '' : ' (not enforced outside the development tree)')
      : sf.reason) + sfWarn + plWarn;
    out.push(line('skill frontmatter', sf.ok, detail + overrideTag(sf)));
  }
  // SA-P1B-DOCTOR: skill_adapters, ENFORCED in the development tree; a broken adapter is named either way.
  if (c.skill_adapters) {
    const sa = c.skill_adapters;
    const ran = (sa.adapters || []).filter((a) => a.applicable);
    const detail = (sa.broken || []).length ? sa.reason
      : (ran.length ? ran.map((a) => a.id + ' ok' + timingLabel(a)).join(' · ') : 'n/a — ' + sa.reason);
    // a warning state (claude-mem launcher missing from THIS session's PATH) is printed, never hidden.
    const saWarn = (sa.warnings || []).length ? ' · WARN ' + sa.warnings.join('; ') : '';
    out.push(line('skill adapters', sa.ok, detail + saWarn + overrideTag(sa)));
  }
  // W2-WIRE: ecc_path + citations, one line each (ENFORCED in the development tree).
  out.push(...toolSummaryLines(c, line));
  // ALWAYS printed (like context_budget below) — this is informational every run, not
  // only on a problem, and 'not-installed' is the NORMAL case for an ordinary project (never a ✗, never
  // part of the ALL GREEN / FAILURES verdict).
  if (rep.advisory && rep.advisory.command_center_location) {
    const ccl = rep.advisory.command_center_location;
    const detail = ccl.location === 'project-local' ? 'project-local at ' + ccl.path
      : ccl.location === 'central' ? 'central (shared) install at ' + ccl.path
      : 'not installed for this project (normal — most projects have none; "forge dashboard" installs/builds it on demand)';
    out.push('  ' + (ccl.location === 'not-installed' ? 'ℹ' : '✓') + ' command center (advisory): ' + detail);
  }
  // Advisory (never fails the doctor, never part of the ALL GREEN / FAILURES verdict above) — printed as a
  // WARN line, distinct from the ✓/✗ check lines, so it can never be mistaken for a blocking result.
  if (rep.advisory && rep.advisory.backfill_continuity) {
    const bc = rep.advisory.backfill_continuity;
    if (bc.warnings && bc.warnings.length) {
      out.push('  ⚠ backfill continuity (advisory, non-blocking): ' + bc.warnings.length + ' WARNING(S): '
        + bc.warnings.map((w) => w.agent + ' in ' + w.run + ' (expected ' + w.expected + ', found ' + w.found + ')').join('; '));
    } else {
      out.push('  ✓ backfill continuity (advisory): ' + bc.applicableRuns + '/' + bc.checkedRuns + ' run(s) use dispatch_id · consistent');
    }
  }
  // run-liveness advisory: a ledger that still claims "running" while the events
  // prove otherwise. Same WARN-line posture as backfill continuity above: never a ✓/✗ check line, never part
  // of the ALL GREEN / FAILURES verdict. The detail is capped at 3 named runs + a count so a project with a
  // long history of stale ledgers still prints one readable line.
  if (rep.advisory && rep.advisory.run_liveness) {
    const rl = rep.advisory.run_liveness;
    const fs_ = rl.findings || [];
    if (fs_.length) {
      const hrs = (ms) => (ms == null ? 'unknown' : Math.round(ms / 3600000) + 'h');
      // WP-DOC-ADV: live findings (silent < 7d) are listed by name; abandoned ones (>= 7d) are only counted.
      const live = fs_.filter((f) => !f.abandoned);
      const abandonedN = fs_.length - live.length;
      const shown = live.slice(0, 3).map((f) => f.run_id + ' (' + f.kind + ', silent ' + hrs(f.silent_ms) + ')');
      const abandonedPart = abandonedN ? abandonedN + ' abandoned (>7d, close or archive them)' : '';
      const livePart = live.length
        ? live.length + ' run(s) still marked running but proven not alive: ' + shown.join('; ') + (live.length > 3 ? '; +' + (live.length - 3) + ' more' : '')
        : '';
      out.push('  ⚠ run liveness (advisory, non-blocking): ' + [livePart, abandonedPart].filter(Boolean).join(' · '));
    } else {
      out.push('  ✓ run liveness (advisory): ' + rl.checked + ' run(s) claiming "running" checked · '
        + (rl.reason || 'each one is genuinely alive or honestly closed'));
    }
  }
  // one compact context-budget line. ALWAYS printed (unlike the failure-only advisories above):
  // the whole point is that the number is visible every run, because the failure mode being guarded is
  // silent growth — a line that only appears once a threshold is already crossed would restore exactly the
  // blindness this check exists to remove. The word "est." is in the line itself, not only in the JSON.
  if (rep.advisory && rep.advisory.context_budget) {
    const cbd = rep.advisory.context_budget;
    // the per-source skill breakdown is rendered by forge-contextbudget's own skillSourceLine() so the doctor
    // line and the tool's CLI can never quote different numbers (2026-08-01: the meter counted only this
    // project's 57 skills while the session carries 278, and the doctor line repeated that figure as if it
    // were the whole surface — one number, one renderer, from now on).
    const breakdown = (contextBudgetTool && typeof contextBudgetTool.skillSourceLine === 'function')
      ? contextBudgetTool.skillSourceLine(cbd) : '';
    const head = (cbd.total_approx_tokens || 0) + ' est. tokens always-loaded across ' + ((cbd.posts || []).length)
      + ' post(s)' + (breakdown ? ' · ' + breakdown : '');
    const fnd = cbd.findings || [];
    if (fnd.length) {
      out.push('  ⚠ context budget (advisory, non-blocking): ' + head + ' · ' + fnd.length + ' finding(s): '
        + fnd.slice(0, 3).map((f) => f.detail).join(' · ') + (fnd.length > 3 ? ' · +' + (fnd.length - 3) + ' more' : ''));
    } else {
      const notes = (cbd.notes || []).map((n) => n.detail);
      out.push('  ✓ context budget (advisory): ' + head + ' · ' + (cbd.reason || 'within baseline')
        + (notes.length ? ' · ' + notes.join(' · ') : ''));
    }
  }
  // wp-v3 (sec-v1r, item 4): forge-gate-hook.cjs's own super-linear-DoS protection depends on
  // forge-gate-watchdog.cjs/worker_threads loading — visible every run, never silent, never a hard failure
  // (the fallback itself is safe). See gateWatchdogHealth() above.
  if (rep.advisory && rep.advisory.gate_watchdog_health) {
    const gwh = rep.advisory.gate_watchdog_health;
    out.push('  ' + (gwh.ok ? '✓' : '⚠') + ' gate watchdog health (advisory' + (gwh.ok ? '' : ', non-blocking') + '): ' + gwh.detail);
  }
  // + part ii: four advisories, one line each — ⚠ on a finding, ✓/ℹ otherwise, never a ✗.
  const adv = (rep.advisory || {});
  const advLine = (label, r, okText, warnText) => {
    if (!r) return;
    if (r.applicable === false) { out.push('  ℹ ' + label + ' (advisory): n/a — ' + r.reason); return; }
    out.push('  ' + (r.ok ? '✓ ' : '⚠ ') + label + (r.ok ? ' (advisory): ' + okText : ' (advisory, non-blocking): ' + warnText));
  };
  if (adv.scribe_wiring) advLine('scribe wiring', adv.scribe_wiring, 'both hooks wired · FORGE_SCRIBE.json parses · .claude/forge-scribe/ gitignored' + ((adv.scribe_wiring.notes || []).length ? ' · ' + adv.scribe_wiring.notes.join(' · ') : ''), adv.scribe_wiring.reason);
  if (adv.unpublished) {
    const up = adv.unpublished;
    if (up.applicable === false) out.push('  ℹ unpublished (advisory): n/a — ' + up.reason);
    else if (up.unpublished) out.push('  ⚠ unpublished (advisory, non-blocking): ' + up.summary);
    else out.push('  ' + (up.verified ? '✓' : 'ℹ') + ' unpublished (advisory): ' + up.reason);
  }
  if (adv.structure) {
    const st = adv.structure, f = st.findings || {};
    const parts = [];
    if ((f.tools_without_test || []).length) parts.push(f.tools_without_test.length + ' tool(s) without a test: ' + f.tools_without_test.slice(0, 5).join(', ') + (f.tools_without_test.length > 5 ? ', +' + (f.tools_without_test.length - 5) : ''));
    if ((f.oversize || []).length) parts.push(f.oversize.length + ' new file(s) over 800 lines: ' + f.oversize.slice(0, 4).join(', '));
    if ((f.readme_missing || []).length) parts.push('README tool table misses ' + f.readme_missing.join(', '));
    if ((f.readme_extra || []).length) parts.push('README names missing tool(s) ' + f.readme_extra.join(', '));
    if ((f.skill_registry_missing || []).length) parts.push('skill registry misses ' + f.skill_registry_missing.join(', '));
    if ((f.skill_registry_extra || []).length) parts.push('skill registry names missing skill(s) ' + f.skill_registry_extra.join(', '));
    if ((f.root_clutter || []).length) parts.push('root clutter: ' + f.root_clutter.join(', '));
    if (f.no_remote) parts.push('this repository has NO git remote — nothing reaches GitHub');
    advLine('structure', st, 'every tool has a test · no new oversized file · README and skill registry match the disk · root clean · remote configured', parts.join(' · '));
  }
  if (adv.always_loaded_budget) {
    const ab = adv.always_loaded_budget;
    const sizes = (ab.files || []).map((x) => x.file.split('/').slice(-2).join('/') + ' ' + (x.bytes == null ? 'absent' : x.bytes + ' B' + (x.over ? ' OVER' : ''))).join(', ');
    advLine('always-loaded budget', ab, sizes + ' (budget ' + ab.budget + ' B each)', sizes + ' — over the ' + ab.budget + ' B budget: move detail into .claude/docs/forge-reference/');
  }
  for (const [key, label] of [['skill_lint', 'skill lint'], ['agent_lint', 'agent lint']]) {
    const r = adv[key];
    if (!r) continue;
    const c = r.counts || {};
    const tally = r.checked + ' checked · ' + (c.error || 0) + ' error · ' + (c.warn || 0) + ' warn';
    advLine(label, r, tally + ((r.warnings || []).length ? ' (first: ' + r.warnings[0] + ')' : ''), tally + ': ' + (r.errors || []).join(' · ') + ' — details: ' + r.command);
  }
  if (adv.config_scan) {
    const r = adv.config_scan, c = r.counts || {};
    const tally = r.checked + ' file(s) · ' + (c.error || 0) + ' error · ' + (c.warn || 0) + ' warn';
    advLine('config scan', r, tally + ((r.warnings || []).length ? ' (first: ' + r.warnings[0] + ')' : ''), tally + ': ' + (r.errors || []).join(' · ') + ' — details: ' + r.command);
  }
  if (adv.harness_score) {
    const r = adv.harness_score;
    const head = 'overall ' + r.overall + '/10 over ' + r.measured + '/' + r.total + ' measured categories (doctor checks not fed in)';
    advLine('harness score', r, head, head + (r.failed && r.failed.length ? ' · failed: ' + r.failed.join(', ') : '') + (r.top_actions && r.top_actions.length ? ' · first: ' + r.top_actions[0] : '') + ' — details: ' + r.command);
  }
  if (adv.plugin_validate) advLine('plugin validate', adv.plugin_validate, '`claude plugin validate ' + PLUGIN_DIST_REL + '` passed', '`claude plugin validate ' + PLUGIN_DIST_REL + '` failed: ' + (adv.plugin_validate.errors || []).join(' · '));
  // WAVE A / A2 + V9-INTEGRATE: one compact "completeness" advisory line for the
  // checks that remain advisory-only — never folded into ALL GREEN/FAILURES. unregistered_event/
  // check_the_checks moved OUT of this block — they are now ordinary ✓/✗ checks-lines above,
  // since they were promoted to ENFORCED (see the header doc's "V9-INTEGRATE enforcement" note).
  if (rep.advisory && rep.advisory.completeness) {
    const cm = rep.advisory.completeness;
    const parts = [];
    if (cm.sync_completeness && !cm.sync_completeness.ok) parts.push('sync-completeness: ' + (cm.sync_completeness.missing ? cm.sync_completeness.missing.length + ' file(s) not in FILES manifest' : (cm.sync_completeness.reason || 'unavailable')));
    if (cm.memory_discipline && !cm.memory_discipline.ok) parts.push('memory-discipline: ' + (cm.memory_discipline.reason || 'unfilled placeholder(s)'));
    if (cm.mcp_dormancy && !cm.mcp_dormancy.ok) parts.push('mcp-dormancy: ' + (cm.mcp_dormancy.violations ? cm.mcp_dormancy.violations.length + ' violation(s)' : (cm.mcp_dormancy.reason || 'unavailable')));
    if (cm.quality_catalog && !cm.quality_catalog.ok) parts.push('quality-catalog: ' + (cm.quality_catalog.reason || 'drift'));
    if (cm.skill_evals && !cm.skill_evals.ok) {
      const se = cm.skill_evals;
      const failNames = (se.skills || []).filter((s) => !s.ok).map((s) => s.error ? (s.skill + ' (config error: ' + s.error + ')') : (s.skill + ' (' + s.failed + '/' + s.total + ' assertion(s) failed: ' + s.results.filter((r) => !r.ok).map((r) => r.id).join(', ') + ')'));
      parts.push('skill-evals: ' + (failNames.length ? failNames.join('; ') : (se.reason || 'unavailable')));
    }
    // wp-disclosure-ab: skill_hygiene's clean-branch text carries a REAL count ("skill hygiene
    // N/M") rather than a static phrase, per the work package's requested format — computed once so it is
    // available to whichever branch below actually fires. An unhealthy result still names the failing
    // skill(s) in `parts`, the exact same convention every other completeness sub-check above already uses.
    let skillHygieneCleanText = '';
    if (cm.skill_hygiene) {
      const sh = cm.skill_hygiene;
      if (!sh.ok) {
        const failNames = (sh.skills || []).filter((s) => !s.ok).map((s) => s.skill + ' (' + s.issues.join('; ') + ')');
        parts.push('skill-hygiene: ' + (failNames.length ? failNames.join('; ') : (sh.reason || 'unavailable')));
      } else {
        skillHygieneCleanText = ' · skill hygiene ' + sh.skills.filter((s) => s.ok).length + '/' + sh.checked;
      }
    }
    out.push(parts.length
      ? '  ⚠ completeness (advisory, non-blocking): ' + parts.join(' · ')
      : '  ✓ completeness (advisory): sync manifest complete · memory populated · mcp dormant/least-privilege · skill evals green' + skillHygieneCleanText);
  }
  // one line per beginner-setup check, ALWAYS printed (a beginner reads these for the info
  // as much as for the warnings). ⚠ = warn, ℹ = info/note, ✓ = ok / not applicable — never a ✗, never in the
  // verdict. `note` (wp-l1, loop iteration 1: settings-wired) is the same non-judgmental ℹ treatment as
  // `info` — "could not compare" is not a warning, it is a fact about what data was available.
  if (rep.advisory && rep.advisory.beginner_setup && rep.advisory.beginner_setup.checks) {
    for (const bc of Object.values(rep.advisory.beginner_setup.checks)) {
      const warn = bc.level === 'warn' && !bc.overridden;
      const icon = warn ? '⚠' : ((bc.level === 'info' || bc.level === 'note') ? 'ℹ' : '✓');
      out.push('  ' + icon + ' setup ' + bc.id + (warn ? ' (advisory, non-blocking): ' : ' (advisory): ') + (bc.level === 'n-a' ? 'n/a — ' : '') + bc.detail + overrideTag(bc));
      if (Array.isArray(bc.lines)) for (const l of bc.lines) out.push('      │ ' + l);
    }
  }
  out.push(rep.ok ? '  ⇒ ALL GREEN' : '  ⇒ FAILURES ABOVE');
  return out.join('\n');
}

module.exports = {
  printSummary,
};
