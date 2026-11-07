'use strict';
/**
 * doctor/overrides.cjs — one module of forge-doctor.cjs (WP A11 part 2): doctor_check_overrides: loadDoctorCheckOverrides and applyDoctorOverride.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */
const path = require('path');
const fs = require('fs');
const { claudeDir } = require('./context.cjs');

/** loadDoctorCheckOverrides — reads config/orchestration/FORGE_HARD_RULES.json's `doctor_check_overrides`
 *  array (see that file's own top-level doc for the exact shape: {check, reason, by, ts}). A missing file,
 *  malformed JSON, or a missing/empty `doctor_check_overrides` array all degrade to "no overrides" ([]) —
 *  this is an OPT-IN recovery mechanism, not a required config; its absence must never be an error. Every
 *  entry MUST carry a non-empty string `check` id and a non-empty string `reason` (a blank/templated reason
 *  is silently dropped, same "no blank override" discipline forge-scout.cjs's record() enforces for its own
 *  ledger) — a malformed single entry is skipped, never crashes the whole read. */
function loadDoctorCheckOverrides(root) {
  const p = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  if (!data || !Array.isArray(data.doctor_check_overrides)) return [];
  return data.doctor_check_overrides.filter((o) => o && typeof o.check === 'string' && o.check.trim() && typeof o.reason === 'string' && o.reason.trim());
}
/** applyDoctorOverride — a promoted-to-ENFORCED check's result is passed through UNCHANGED when it already
 *  passes (an override never "improves" a real pass into something more positive than reality) or when no
 *  matching override entry exists. Only a GENUINE failure with a matching, valid override entry is turned
 *  into a visible-but-honest pass: `ok:true` PLUS `overridden:true` + the real reason/by fields, so
 *  printSummary() can render it distinctly from an ordinary clean pass (see the '[OVERRIDDEN: ...]' tag) —
 *  never a silent bypass. */
function applyDoctorOverride(overrideMap, checkId, result) {
  if (result.ok) return result;
  const ov = overrideMap.get(checkId);
  if (!ov) return result;
  return Object.assign({}, result, { ok: true, overridden: true, override_reason: ov.reason, override_by: (ov.by && String(ov.by).trim()) || 'owner' });
}

module.exports = {
  loadDoctorCheckOverrides, applyDoctorOverride,
};
