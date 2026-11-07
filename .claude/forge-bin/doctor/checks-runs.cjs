'use strict';
/**
 * doctor/checks-runs.cjs — one module of forge-doctor.cjs (WP A11 part 2): run picking (rankRunCandidates, latestRunIdFor), quality_catalog, run_contract (enforced), skill_evals.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, runContractTool, runsDirOf, skillEvalsTool } = require('./context.cjs');
const { parseEventsJsonlLenient } = require('./checks-agents.cjs');
const { readDevTreeMarker } = require('./checks-hygiene.cjs');

// ===========================================================================================================
// V9-INTEGRATE — run-contract wiring + the doctor_check_overrides recovery path. See the header
// doc comment ("V9-INTEGRATE ENFORCEMENT OVERRIDE PATH") for the full model.
// ===========================================================================================================

/** rankRunCandidates(root, opts) -> [{name, mtimeMs}, ...] sorted newest-first. Shared ranking core behind
 *  BOTH latestRunIdFor() and latestDispatchedRunIdFor() below — one recency algorithm, never two that could
 *  silently drift apart. Ranks by REAL recency: the latest of (a) events.jsonl's own mtime — the truest
 *  "last real activity" signal, updated on every real event append — (b) run.json's mtime, and (c) the run
 *  directory's own mtime, taking the max of whichever of these exist. Name is only a TIE-BREAK (descending)
 *  for the vanishingly-rare case of two runs with an identical mtime down to the millisecond.
 *  opts.requireDispatched:true (V9, 2026-07-22 — forge-audit-loop's own doctor-receipt-vs-real-run
 *  gap) additionally requires a REAL, parseable run.json object — a "doctor-receipt-only" directory (created
 *  solely by this file's own `--run <id>` CLI flag: a doctor.json snapshot + a single synthetic doctor_run
 *  event in events.jsonl, but NO run.json at all — see this file's own CLI body below) is never mistaken for
 *  a genuine DISPATCHED Forge run, which always has a real run.json written by the orchestration layer.
 *  Without opts.requireDispatched, behavior is byte-for-byte the original "any real run dir" filter (must
 *  have a real run.json OR events.jsonl) — unchanged. */
/** lastEventTimeMs(file) -> ms sinds epoch van het LAATSTE parseerbare event, of 0.
 *  Leest alleen de staart (8 KiB): de rangschikking mag niet duurder worden naarmate een run groeit, en
 *  het laatste event staat per definitie achteraan. Een half afgeknotte eerste regel in dat venster
 *  parseert simpelweg niet en wordt overgeslagen — daarom van achter naar voren. */
function lastEventTimeMs(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return 0;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const t = Date.parse(o && (o.ingested_at || o.timestamp)); // the writer-stamped instant wins
        if (Number.isFinite(t)) return t;
      } catch { /* afgeknotte of corrupte regel — probeer de vorige */ }
    }
    return 0;
  } catch { return 0; }
  finally { try { fs.closeSync(fd); } catch { } }
}

function rankRunCandidates(root, opts) {
  opts = opts || {};
  const dir = runsDirOf(root);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(dir, e.name);
    const eventsPath = path.join(runDir, 'events.jsonl');
    const runJsonPath = path.join(runDir, 'run.json');
    const hasEvents = fs.existsSync(eventsPath);
    const hasRunJson = fs.existsSync(runJsonPath);
    if (opts.requireDispatched) {
      let parsedRunJson = null;
      if (hasRunJson) { try { parsedRunJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { parsedRunJson = null; } }
      if (!parsedRunJson || typeof parsedRunJson !== 'object' || Array.isArray(parsedRunJson)) continue; // no real run.json -> not a genuine dispatched run
    } else if (!hasEvents && !hasRunJson) {
      continue; // not a real Forge run dir at all — never a pickable candidate
    }
    let mtimeMs = 0;
    try {
      if (hasEvents) mtimeMs = Math.max(mtimeMs, fs.statSync(eventsPath).mtimeMs);
      if (hasRunJson) mtimeMs = Math.max(mtimeMs, fs.statSync(runJsonPath).mtimeMs);
      mtimeMs = Math.max(mtimeMs, fs.statSync(runDir).mtimeMs);
    } catch { /* a stat race on an individual file never disqualifies the candidate — 0/partial mtime is still real evidence */ }
    /** REGRESSIE 2026-08-09: rangschikken op mtime laat ELKE metadata-write de geschiedenis herordenen.
     *  forge-finalize's markRunFinalized() herschreef de run.json van een oude, groene run; die ene
     *  aanraking maakte hem "laatste dispatched run", waardoor de doctor "run contract satisfied" meldde
     *  terwijl de ECHT actieve run nog 5 verplichte regels miste — een reëel gat, onzichtbaar gemaakt door
     *  boekhouding. forge-snapshot.cjs leerde dit al op 2026-08-01 en herrangschikte in zijn EIGEN code;
     *  de gedeelde kern hield het gebrek, dus de volgende aanroeper erfde het. Daarom hier, één keer:
     *  recentheid van een RUN is de recentheid van zijn WERK. Eventtijden worden één keer geschreven en
     *  nooit herschreven; mtimes wel. Zonder eventlog blijft de mtime de eerlijke terugval. */
    const activityMs = hasEvents ? lastEventTimeMs(eventsPath) : 0;
    candidates.push({ name: e.name, mtimeMs, activityMs, rankMs: activityMs || mtimeMs });
  }
  candidates.sort((a, b) => (b.rankMs - a.rankMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return candidates;
}
/** latestRunIdFor — the single most-recent run id under <root>/.claude/forge-runs/, ANY real run directory
 *  (a run.json OR an events.jsonl is enough — this is the general-purpose "most recently touched run"
 *  picker; see latestDispatchedRunIdFor() below for the stricter "genuinely dispatched" variant used by
 *  runContractDoctorCheck()). V9-fix (break-swarm DEFECT 4): the OLD implementation picked
 *  "latest" by a plain lexical name sort — a clean decoy run whose directory name simply sorts higher (e.g.
 *  "zzz-decoy") masked a genuinely NEWER, real-violating run whose name happens to sort lower. Now ranks by
 *  REAL recency via rankRunCandidates() — see that function's doc for the exact algorithm. null when no real
 *  run directories exist yet (a fresh project) or the directory can't be read — never thrown. */
function latestRunIdFor(root) {
  const candidates = rankRunCandidates(root, {});
  return candidates.length ? candidates[0].name : null;
}
/** latestDispatchedRunIdFor — V9 (forge-audit-loop's own honest-realization pass): the
 *  most-recent run id that carries a REAL, parseable run.json — i.e. a genuinely DISPATCHED Forge run, never
 *  a "doctor-receipt-only" directory (see rankRunCandidates()'s opts.requireDispatched doc above). Used by
 *  runContractDoctorCheck() below so its advisory never mistakes `forge-doctor --run <id>`'s own receipt
 *  directory (created by THIS file's CLI body — doctor.json + one synthetic doctor_run event, no run.json)
 *  for a real dispatched run whose non-negotiables are worth evaluating. null when no genuinely dispatched
 *  run exists yet under forge-runs/ (a fresh project, or a project where every run so far is receipt-only) —
 *  never thrown. */
function latestDispatchedRunIdFor(root) {
  const candidates = rankRunCandidates(root, { requireDispatched: true });
  return candidates.length ? candidates[0].name : null;
}
/** runContractDoctorCheck — ENFORCED; see the "run_contract — ENFORCED" block doc right
 *  above its implementation further down. (Until it was an ADVISORY live re-check of the latest run that had
 *  a run.json, which showed red on legitimately finalized runs once HEAD or the rules moved — audit S5.) It still
 *  never evaluates every historical run and never a doctor-receipt-only folder, and a fresh project without any
 *  run degrades to a neutral "no dispatched run to check yet". */
/** qualityCatalogDoctorCheck — ADVISORY. De domeincatalogus is de ENE verwachting; vier seams (router-
 *  playbooks, required-evidence, intake-packs, domain-presets) zijn de werkelijkheid. Elke afwijking is
 *  drift die hier zichtbaar wordt; tracked gaps (dashboard, tooling/meta) blijven benoemd, nooit stil.
 *  Degradeert eerlijk wanneer de quality-module ontbreekt (kale installatie zonder Quality-laag). */
function qualityCatalogDoctorCheck(root) {
  let Q = null;
  try { Q = require(path.join(claudeDir(root), 'forge-bin', 'forge-quality.cjs')); } catch { }
  /** F-09 (Codex batch-1-review): 'module ontbreekt' was ok:true — maar de sync-manifest SHIPT deze
   *  module, dus afwezigheid is een echte installatiefout, geen optionele feature. Fail-closed. */
  if (!Q || typeof Q.catalogDrift !== 'function') return { ok: false, reason: 'forge-quality.cjs ontbreekt of laadt niet, terwijl de sync-manifest hem verwacht — de installatie is incompleet' };
  try {
    const d = Q.catalogDrift(root);
    /** F-29 (Codex eindreview): het eindoordeel telt VIER afwijkingsvelden mee (missing, extra,
     *  not_expected, stale_tracked) maar de reason noemde er maar twee — drift door een verouderde
     *  tracked gap of een onverwachte preset gaf ok:false met een LEGE reden, dus geen
     *  herstelrichting. Alle vier velden dragen nu bij aan de probleemselectie en de reden. */
    const problemen = d.seams.filter((s2) => (s2.missing_in_seam || []).length || (s2.extra_in_seam || []).length || (s2.not_expected || []).length || (s2.stale_tracked || []).length);
    const beschrijf = (s2) => {
      const delen = [];
      if ((s2.missing_in_seam || []).length) delen.push('missing=' + JSON.stringify(s2.missing_in_seam));
      if ((s2.extra_in_seam || []).length) delen.push('extra=' + JSON.stringify(s2.extra_in_seam));
      if ((s2.not_expected || []).length) delen.push('not_expected=' + JSON.stringify(s2.not_expected));
      if ((s2.stale_tracked || []).length) delen.push('stale_tracked=' + JSON.stringify(s2.stale_tracked) + ' (de gap-notitie beschrijft een opgeloste werkelijkheid — ruim de known_gap op)');
      return s2.seam + ': ' + delen.join(' ');
    };
    return { ok: d.ok, reason: d.ok ? '' : problemen.map(beschrijf).join(' · '), seams: d.seams.length, domains: d.domains_total };
  } catch (e) { return { ok: false, reason: 'catalogDrift wierp: ' + e.message }; }
}

/** ============ run_contract — ENFORCED (audit T11/S4/S5) ============
 *  Which run: the NEWEST genuine run (ranked by real work recency, rankRunCandidates). Genuine = a parseable
 *  run.json OR a run_started event — the run.json-only filter missed real runs that never wrote one (the goat
 *  run and this overhaul run among them), while a doctor-receipt-only folder (doctor.json + one doctor_run
 *  event) still never qualifies.
 *  What makes it red (enforced, folded into doctor.ok, escape hatch: doctor_check_overrides 'run_contract'):
 *    - completed-red           the newest run logged run_completed while the completion sequence was unmet
 *                              (contract red, gate evidence missing/red, no final report, or no fresh proof);
 *    - completed-not-finalized it logged run_completed but was never finalized (step 5 skipped);
 *    - finalized-stale         its receipt (or the latest finalized run's receipt) no longer holds — STALE.
 *  What is never red:
 *    - in-progress             no completion claimed yet. Overdue obligations are listed, not enforced: the
 *                              doctor is itself a gate inside step 1, so a red verdict on unfinished work would
 *                              deadlock the very sequence it checks;
 *    - closed-failed           an honest failure close claims no completion;
 *    - finalized / finalized-historical — read through forge-finalize check() (evaluateAcceptance). A HISTORICAL
 *                              record is reported with its cause and whether it was re-verified; a bare
 *                              HISTORICAL is never presented as "re-verified OK" (S5); an unverified-archival or
 *                              otherwise unauthenticated archival receipt is never a completion proof:
 *                              red for an enforced claim, finalized-archival with completion_proof:false otherwise;
 *    - undetermined            the receipt's git state cannot be read: RED in the development tree,
 *                              an ok:true NOTE (status 'undetermined') everywhere else;
 *    - a completion claim is sticky: work logged after run_completed keeps the run 'completed' (red until
 *      it is finalized after a new run_completed, or closed as failed), it never turns back into "in progress";
 *    - anything whose completion claim PREDATES RUN_CONTRACT_ENFORCED_SINCE (the day this recipe and gate
 *      shipped): reported, not enforced — older runs never had the recipe, and a synced project must not turn
 *      red on its history (rules use `since` for the same reason).
 *  Degrades to ok:true with a reason when forge-runcontract.cjs (planFor) is unavailable or no run exists. */
// 2026-10-10 00:00 Europe/Amsterdam (CEST) — the night the completion recipe and the run_completed gate shipped.
// Written as a UTC instant on purpose: a bare '2026-10-10' would be UTC midnight, two hours AFTER the shipping
// moment, and completions in that window would wrongly read as "history" (caught by the replay test).
const RUN_CONTRACT_ENFORCED_SINCE = '2026-10-09T22:00:00Z';
function isGenuineRunDir(runDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) return true;
  } catch { /* no usable run.json — fall through to the run_started test */ }
  try { return /"event_type"\s*:\s*"run_started"/.test(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')); }
  catch { return false; }
}
function genuineRunCandidates(root) {
  const runsDir = runsDirOf(root);
  return rankRunCandidates(root, {}).filter((c) => isGenuineRunDir(path.join(runsDir, c.name)));
}
/** eventTimeMs(e) — F05 (Codex adversarial review): the WRITER-stamped `ingested_at` is the time of
 *  record; `timestamp` is only the fallback for history written before the writer stamped it (which predates
 *  every enforcement date). A caller-supplied timestamp survives only as `claimed_ts` and never decides anything. */
function eventTimeMs(e) {
  if (runContractTool && typeof runContractTool.tsOf === 'function') { const ms = runContractTool.tsOf(e); return ms === null ? null : ms; }
  for (const f of ['ingested_at', 'timestamp']) { const ms = Date.parse(e && e[f]); if (Number.isFinite(ms)) return ms; }
  return null;
}
/** completionClaimOf(runDir) -> {claimed, at_ms, started_ms} from a LENIENT read (a damaged log is the chain
 *  check's job). started_ms = the run's start (run_started, else the first dated event) for the F01 cutoff. */
function completionClaimOf(runDir) {
  let evs;
  try { evs = parseEventsJsonlLenient(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')); } catch { return { claimed: false, at_ms: null, started_ms: null, unreadable: true }; }
  let startedMs = null;
  const rs = evs.find((e) => e.event_type === 'run_started');
  if (rs) startedMs = eventTimeMs(rs);
  if (startedMs === null) for (const e of evs) { const ms = eventTimeMs(e); if (ms !== null) { startedMs = ms; break; } }
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].event_type === 'run_completed') {
      const ms = eventTimeMs(evs[i]);
      return { claimed: true, at_ms: ms, started_ms: startedMs };
    }
  }
  return { claimed: false, at_ms: null, started_ms: startedMs };
}
function finalizeCheckOf(root, runId) {
  let F;
  try { F = require('../forge-finalize.cjs'); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize.cjs could not be loaded (' + e.message + ')' }; }
  try { return F.check(root, runId); } catch (e) { return { verdict: 'UNAVAILABLE', reason: 'forge-finalize check threw (' + e.message + ')' }; }
}
function acceptanceText(fin) {
  if (runContractTool && typeof runContractTool.acceptanceLabel === 'function') return runContractTool.acceptanceLabel(fin);
  return String((fin && fin.verdict) || 'unknown') + (fin && fin.reason ? ' — ' + String(fin.reason).slice(0, 160) : '');
}
/** judgeRunForDoctor(root, runId, sinceIso) -> {ok, enforced, status, run_id, reason, ...} — see the block doc. */
function judgeRunForDoctor(root, runId, sinceIso) {
  const runDir = path.join(runsDirOf(root), runId);
  const claim = completionClaimOf(runDir);
  const sinceMs = Date.parse(sinceIso.length === 10 ? sinceIso + 'T00:00:00Z' : sinceIso);
  // an undatable claim is enforced (the strict direction, like a `since` block rule on an undatable run)
  const claimEnforced = claim.claimed && (claim.at_ms === null || claim.at_ms >= sinceMs);
  const notEnforcedNote = claim.claimed && !claimEnforced ? ' [completion claimed before ' + sinceIso + ': reported, not enforced]' : '';
  const base = { run_id: runId, claim_at: claim.at_ms === null ? null : new Date(claim.at_ms).toISOString(), started_at: claim.started_ms == null ? null : new Date(claim.started_ms).toISOString(), enforced_since: sinceIso };
  if (fs.existsSync(path.join(runDir, 'run-finalized.json'))) {
    const fin = finalizeCheckOf(root, runId);
    const acceptance = { verdict: fin.verdict, cause: fin.cause || null, reverified: fin.reverified === true, label: acceptanceText(fin) };
    if (fin.verdict === 'FINALIZED') return Object.assign(base, { ok: true, enforced: claimEnforced, status: 'finalized', acceptance, completion_proof: true, reason: acceptance.label });
    if (fin.verdict === 'HISTORICAL') {
      /** a HISTORICAL record counts as completion proof only when
       *  finalize RE-VERIFIED it (reverified:true) or the run started before the completion-proof cutoff. An
       *  archival (not re-verified) record of an enforcement-era run is RED when its claim is enforced — the
       *  same since-rule as every other red here — and is always labelled "archival, not a completion proof". */
      const proof = runContractTool && typeof runContractTool.completionProofOf === 'function'
        ? runContractTool.completionProofOf(fin, claim.started_ms, completionProofCutoff(root))
        : { ok: fin.reverified === true, archival: fin.reverified !== true, reason: acceptance.label };
      acceptance.completion_proof = proof.ok; acceptance.archival = proof.archival; acceptance.label = proof.reason;
      if (proof.ok) return Object.assign(base, { ok: true, enforced: claimEnforced, status: proof.archival ? 'finalized-archival' : 'finalized-historical', acceptance, completion_proof: true, reason: proof.reason });
      return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'finalized-archival', acceptance, completion_proof: false, reason: 'the finalize receipt is an ARCHIVAL record, not a completion proof — ' + proof.reason + notEnforcedNote });
    }
    if (fin.verdict === 'STALE') return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'finalized-stale', acceptance, completion_proof: false, reason: 'the finalize receipt no longer holds — ' + acceptance.label + notEnforcedNote });
    /** a finalize checker that cannot run is a tool failure the doctor must show RED, never "undetermined, ok". */
    if (fin.verdict === 'UNAVAILABLE') return Object.assign(base, { ok: false, enforced: true, status: 'finalize-unavailable', acceptance, completion_proof: false, reason: 'the finalize receipt could not be evaluated — ' + (fin.reason || acceptance.label) });
    /** UNDETERMINED (the git state of this root cannot be read right now — dubious
     *  ownership, a repo without commits, git missing) used to be ok:true, so a broken git probe read as a pass.
     *  In the DEVELOPMENT tree (forge-dev-tree.json) it is RED with the reason: the receipt is bound to a commit
     *  nobody can confirm. Everywhere else it stays ok:true but says so (status 'undetermined', note:true), so a
     *  synced project without a working git never deadlocks on its own history. An unknown verdict string is
     *  treated the same way (never trusted as a pass). */
    if (fin.verdict !== 'NOT_FINALIZED') {
      const why = 'the finalize receipt could not be confirmed — ' + acceptance.label;
      if (readDevTreeMarker(root).valid) {
        return Object.assign(base, { ok: false, enforced: true, status: 'finalized-undetermined', acceptance, completion_proof: false, reason: why + ' — in the development tree an undetermined git state is RED: repair git for this root (safe.directory, a first commit, git on PATH) and re-run the doctor' });
      }
      return Object.assign(base, { ok: true, enforced: false, status: 'undetermined', note: true, acceptance, completion_proof: false, reason: why + ' [NOTE: reported, not enforced outside the development tree]' });
    }
    // NOT_FINALIZED: the receipt vanished between the exists-check and the read — judge the run live below
  }
  let plan;
  try { plan = runContractTool.planFor({ run_id: runId }, { root }); }
  catch (e) {
    return Object.assign(base, { ok: !claimEnforced, enforced: claimEnforced, status: 'unjudgeable', reason: 'the run contract could not be evaluated (' + e.message + ')' + (claim.claimed ? notEnforcedNote : ' — no completion claimed, so this is reported, not enforced') });
  }
  const st = plan.state;
  const steps = plan.sequence.map((s) => ({ id: s.id, status: s.status }));
  const common = { missing: plan.contract.missing, warnings: plan.contract.warnings, steps, next: plan.next.text, phase: st.phase };
  if (st.status === 'closed-failed') return Object.assign(base, common, { ok: true, enforced: false, status: 'closed-failed', reason: 'closed as failed — no completion is claimed' });
  if (st.status !== 'completed') {
    const overdue = plan.obligations.filter((o) => o.due === 'overdue').map((o) => o.id);
    return Object.assign(base, common, { ok: true, enforced: false, status: 'in-progress', overdue,
      reason: st.status + ' (phase ' + st.phase + '), completion not claimed yet' + (overdue.length ? ' · overdue (enforced only once completion is claimed): ' + overdue.join(', ') : '') });
  }
  const unmet = plan.sequence.filter((s) => s.id !== 'finalize' && (s.status === 'pending' || s.status === 'red'));
  if (unmet.length || plan.contract.ok !== true) {
    const parts = unmet.map((s) => 'step ' + s.step + ' ' + s.id + ' ' + s.status);
    return Object.assign(base, common, { ok: !claimEnforced, enforced: claimEnforced, status: 'completed-red',
      reason: 'run_completed was logged over an unmet completion sequence: ' + (parts.join(', ') || 'contract red') + (plan.contract.missing.length ? ' (missing: ' + plan.contract.missing.join(', ') + ')' : '') + ' → node .claude/forge-bin/forge-runcontract.cjs plan --run ' + runId + notEnforcedNote });
  }
  const finStep = plan.sequence.find((s) => s.id === 'finalize');
  return Object.assign(base, common, { ok: !claimEnforced, enforced: claimEnforced, status: 'completed-not-finalized',
    reason: 'run_completed is logged and steps 1-3 are met, but the run was never finalized → ' + ((finStep && finStep.command) || 'node .claude/forge-bin/forge-runcontract.cjs check --run ' + runId + ' --log-event --finalize') + notEnforcedNote });
}
/** completionProofCutoff(root) — the F01 cutoff from the ONE registry (completion_proof.enforcement_cutoff), else
 *  forge-runcontract's constant. */
function completionProofCutoff(root) {
  try {
    const rules = JSON.parse(fs.readFileSync(path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8'));
    if (runContractTool && typeof runContractTool.completionProofCutoffOf === 'function') return runContractTool.completionProofCutoffOf(rules);
    const v = rules && rules.completion_proof && rules.completion_proof.enforcement_cutoff;
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  } catch { /* fall through to the checker's constant */ }
  return (runContractTool && runContractTool.COMPLETION_PROOF_CUTOFF) || '2026-10-09T00:00:00Z';
}
function runContractDoctorCheck(root, opts) {
  const sinceIso = (opts && opts.enforcedSince) || RUN_CONTRACT_ENFORCED_SINCE;
  /** a checker that cannot load is a tool failure, reported RED with
   *  its reason — never ok:true. (Escape hatch, visibly: doctor_check_overrides 'run_contract'.) */
  if (!runContractTool || typeof runContractTool.planFor !== 'function') {
    return { ok: false, enforced: true, status: 'unavailable', run_id: null, enforced_since: sinceIso, reason: 'forge-runcontract.cjs (planFor) could not be loaded — the run-contract check cannot run, which is a defect of this installation, not a pass; repair/sync forge-runcontract.cjs' };
  }
  const cands = genuineRunCandidates(root);
  if (!cands.length) return { ok: true, enforced: false, status: 'no-run', run_id: null, enforced_since: sinceIso, reason: 'no dispatched run to check yet' };
  const target = judgeRunForDoctor(root, cands[0].name, sinceIso);
  // finalized runs are read through their receipt: the latest finalized one is reported too, and a STALE receipt
  // there is as real a failure as on the newest run (same since-rule)
  const finCand = cands.find((c) => fs.existsSync(path.join(runsDirOf(root), c.name, 'run-finalized.json')));
  let latestFinalized = null;
  if (finCand && finCand.name !== target.run_id) {
    const lf = judgeRunForDoctor(root, finCand.name, sinceIso);
    latestFinalized = { run_id: lf.run_id, ok: lf.ok, enforced: lf.enforced, status: lf.status, acceptance: lf.acceptance || null, reason: lf.reason };
  }
  /** EVERY other run that claimed completion on/after the enforcement
   *  date is judged too — an older completed-but-unfinalized (or red) run used to drop out of the checked set
   *  the moment a newer run started. Runs that never claimed completion stay out (in-progress work is never
   *  blocking, so a new run can always start); pre-enforcement claims are history. Each unresolved claim is
   *  listed with its own status and reason; any red one keeps the whole check red. */
  const sinceMs = Date.parse(sinceIso.length === 10 ? sinceIso + 'T00:00:00Z' : sinceIso);
  const unresolved = [];
  let judgedClaims = 0;
  for (const c of cands) {
    if (c.name === target.run_id || (latestFinalized && c.name === latestFinalized.run_id)) continue;
    const claim = completionClaimOf(path.join(runsDirOf(root), c.name));
    if (!claim.claimed || !(claim.at_ms === null || claim.at_ms >= sinceMs)) continue; // no claim, or history
    judgedClaims++;
    const j = judgeRunForDoctor(root, c.name, sinceIso);
    if (!j.ok) unresolved.push({ run_id: j.run_id, status: j.status, enforced: j.enforced, reason: j.reason, claim_at: j.claim_at });
  }
  const ok = target.ok && (!latestFinalized || latestFinalized.ok) && unresolved.length === 0;
  return Object.assign({}, target, { ok, latest_finalized: latestFinalized, other_claims_judged: judgedClaims, unresolved_claims: unresolved });
}
/** runContractSummary(rc) — the one-line printSummary detail for the enforced run_contract check. */
function runContractSummary(rc) {
  if (!rc) return '';
  let s = rc.run_id ? rc.run_id + ' — ' + (rc.reason || rc.status) : (rc.reason || rc.status || '');
  if (rc.latest_finalized) s += ' · latest finalized ' + rc.latest_finalized.run_id + ': ' + (rc.latest_finalized.ok ? '' : 'RED — ') + ((rc.latest_finalized.acceptance && rc.latest_finalized.acceptance.label) || rc.latest_finalized.reason);
  if (Array.isArray(rc.unresolved_claims) && rc.unresolved_claims.length) s += ' · ' + rc.unresolved_claims.length + ' older unresolved completion claim(s): ' + rc.unresolved_claims.map((u) => u.run_id + ' (' + u.status + ')').join(', ');
  return s.length > 600 ? s.slice(0, 597) + '…' : s;
}

/** skillEvalsDoctorCheck(root) -> {ok, reason, skills, summary} — ADVISORY-ONLY wrapper around
 *  forge-skill-evals.cjs::runAll() (wp-skill-evals, backlog item 1 / YT-SWEEP-2026-07-31, 2026-07-31 —
 *  see that module's own header for the full evals.json schema and assertion-type catalog). A skill with
 *  no evals.json is simply not evaluated by that module — this check never invents a requirement for a
 *  skill that hasn't opted in yet. Degrades honestly (never throws) when the sibling module is
 *  unavailable (soft dependency, same posture as syncTool/verifyTool/runContractTool above) or when the
 *  underlying runAll() call itself throws (a malformed --skill filter can never reach here — this call
 *  never passes one). Zero skills carrying an evals.json yet is vacuously ok:true (a fresh project must
 *  never doctor-fail for opting into nothing). NOT promoted to ENFORCED: this is the FOUNDATION piece of
 *  the self-improvement substrate — no autonomous keep/revert loop exists yet (that stays nightshift-
 *  gated, a later piece), so a real assertion failure here is a signal to review by hand, not yet a build
 *  gate. */
function skillEvalsDoctorCheck(root) {
  if (!skillEvalsTool) return { ok: true, reason: 'forge-skill-evals.cjs module not available (skill-evals check unavailable)', skills: [], summary: null };
  try {
    const out = skillEvalsTool.runAll({ root });
    return {
      ok: out.ok,
      reason: out.ok ? '' : (out.summary.failedSkills + ' skill(s) with a failing/malformed eval'),
      skills: out.skills,
      summary: out.summary,
    };
  } catch (e) {
    return { ok: false, reason: 'forge-skill-evals check threw: ' + e.message, skills: [], summary: null };
  }
}

module.exports = {
  lastEventTimeMs, rankRunCandidates, latestRunIdFor, latestDispatchedRunIdFor, qualityCatalogDoctorCheck,
  RUN_CONTRACT_ENFORCED_SINCE, isGenuineRunDir, genuineRunCandidates, eventTimeMs, completionClaimOf,
  finalizeCheckOf, acceptanceText, judgeRunForDoctor, completionProofCutoff, runContractDoctorCheck,
  runContractSummary, skillEvalsDoctorCheck,
};
