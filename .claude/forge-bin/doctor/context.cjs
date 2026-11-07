'use strict';
/**
 * doctor/context.cjs — one module of forge-doctor.cjs (WP A11 part 2): shared context: Node built-ins, forge-store, the SOFT sibling tools (each degrades to null when absent), state-path helpers, small file helpers.
 * The code below moved here verbatim from forge-doctor.cjs (only sibling paths changed: ./x -> ../x, __dirname
 * -> BIN_DIR). forge-doctor.cjs is the composition root: it runs the checks in its ordered tables and
 * re-exports every name, so callers keep requiring forge-doctor.cjs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('../forge-store.cjs');
// The forge-bin folder (this module lives one level down, in forge-bin/doctor/): every sibling path resolves from here.
const BIN_DIR = path.resolve(__dirname, '..');
// forge-policy.cjs is a SOFT sibling dependency (unlike forge-store.cjs, which agentsCheck/leakScan have
// always required): some hermetic fixtures (e.g. forge-sync.test.cjs's "copy the REAL forge-doctor.cjs"
// integration case) intentionally copy only forge-doctor.cjs + forge-store.cjs to exercise the genuine
// node_check/tests path, without forge-policy.cjs alongside it. A missing forge-policy.cjs must degrade
// the tool-policy sub-check honestly (ok:false, explicit reason) rather than crash the entire doctor run.
let policy = null;
try { policy = require('../forge-policy.cjs'); } catch { policy = null; }
// forge-sync.cjs / forge-verify.cjs are SOFT sibling dependencies too, for the same reason: sync_completeness
// and unregistered_event are ADVISORY, so a hermetic fixture that only ships forge-doctor.cjs + forge-store.cjs
// must degrade those two sub-checks honestly rather than crash the whole doctor run. Both modules guard their
// CLI body behind `require.main === module`, so requiring them here never triggers their CLI side effects.
let syncTool = null;
try { syncTool = require('../forge-sync.cjs'); } catch { syncTool = null; }
let verifyTool = null;
try { verifyTool = require('../forge-verify.cjs'); } catch { verifyTool = null; }
// V9-INTEGRATE: forge-runcontract.cjs is a SOFT sibling dependency too, same reasoning as
// forge-sync.cjs/forge-verify.cjs above — a hermetic fixture that only ships forge-doctor.cjs + forge-store.cjs
// must degrade it honestly rather than crash the whole doctor run. made run_contract ENFORCED;
// a missing module still reads as a neutral "unavailable" (ok:true, reason given), never a crash.
let runContractTool = null;
try { runContractTool = require('../forge-runcontract.cjs'); } catch { runContractTool = null; }
// wp-skill-evals: forge-skill-evals.cjs is a SOFT sibling dependency too, same reasoning as
// syncTool/verifyTool/runContractTool above — skill_evals is ADVISORY-ONLY, so a hermetic fixture that
// only ships forge-doctor.cjs + forge-store.cjs must degrade it honestly rather than crash the whole
// doctor run.
let skillEvalsTool = null;
try { skillEvalsTool = require('../forge-skill-evals.cjs'); } catch { skillEvalsTool = null; }
// forge-runwatch.cjs is a SOFT sibling dependency too, same reasoning as the four
// above — run_liveness is ADVISORY-ONLY. forge-runwatch is read-only and guards its CLI behind
// `require.main === module`, so requiring it here has no side effects.
let runwatchTool = null;
try { runwatchTool = require('../forge-runwatch.cjs'); } catch { runwatchTool = null; }
// forge-contextbudget.cjs is a SOFT sibling dependency on the same terms — context_budget is
// ADVISORY-ONLY and the meter is strictly read-only (it opens the always-loaded instruction chain, most of
// which lives OUTSIDE this project root, and never writes any of it — see that file's header on the
// project boundary). Its absence degrades to an honest "unavailable", never a doctor failure.
let contextBudgetTool = null;
try { contextBudgetTool = require('../forge-contextbudget.cjs'); } catch { contextBudgetTool = null; }
// (prd-w2-discipline M2): forge-release-check.cjs is a SOFT sibling dependency on the
// same terms as the others above (a hermetic fixture copying only forge-doctor.cjs + forge-store.cjs must
// degrade honestly rather than crash). UNLIKE those, release_exclusions is ENFORCED, not advisory — see
// releaseExclusionsCheck() below — so its absence fails the check (ok:false), the same fail-closed posture
// qualityCatalogDoctorCheck() takes for forge-quality.cjs (F-09): this install's own sync-manifest ships
// forge-release-check.cjs, so a missing copy is a real installation defect, not an optional feature.
let releaseCheckTool = null;
try { releaseCheckTool = require('../forge-release-check.cjs'); } catch { releaseCheckTool = null; }
// forge-shipcheck.cjs is a SOFT sibling dependency
// on the same terms. ship_manifest is ENFORCED in the development tree (fail-closed there when the module is
// missing, like release_exclusions) and n/a everywhere else — see shipManifestCheck().
let shipcheckTool = null;
try { shipcheckTool = require('../forge-shipcheck.cjs'); } catch { shipcheckTool = null; }
// forge-registry-gen.cjs is a SOFT sibling dependency on the same terms. feature_registry is
// ENFORCED in the development tree (fail-closed there when the module is missing) and n/a everywhere else.
let regGenTool = null;
try { regGenTool = require('../forge-registry-gen.cjs'); } catch { regGenTool = null; }
// the skill and agent linters, SOFT dependencies for two ADVISORY checks (n/a when absent).
let skillLintTool = null;
try { skillLintTool = require('../forge-skilllint.cjs'); } catch { skillLintTool = null; }
let agentLintTool = null;
try { agentLintTool = require('../forge-agentlint.cjs'); } catch { agentLintTool = null; }
// (wired in package 2.9e): the config scanner and the harness scorecard, both advisory-only.
let configScanTool = null;
try { configScanTool = require('../forge-config-scan.cjs'); } catch { configScanTool = null; }
let harnessScoreTool = null;
try { harnessScoreTool = require('../forge-harness-score.cjs'); } catch { harnessScoreTool = null; }

const NODE = process.execPath;
const DASH_SPA = ['server.cjs', 'index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css'];

function claudeDir(root) { return path.join(root, '.claude'); }
// WP 2.1 (opt-in per project): the runtime-state locations come from forge-paths.cjs, a SOFT sibling dependency like
// the ones above (a copied doctor without it, or an older resolver, keeps every legacy .claude/forge-* path). In a
// project without .forge/ every helper below returns exactly the old path. Readers use resolveExisting (the .forge/
// folder once it exists, else the legacy one); writers use stateDir (the active folder).
let forgePathsTool = null;
try { const fp = require('../forge-paths.cjs'); if (fp && typeof fp.stateDir === 'function' && typeof fp.resolveExisting === 'function' && typeof fp.memoryFile === 'function' && typeof fp.scriptRoot === 'function') forgePathsTool = fp; } catch { forgePathsTool = null; }
function stateReadDir(root, key, legacyName) {
  const legacy = path.join(claudeDir(root), legacyName);
  if (!forgePathsTool) return legacy;
  try { return forgePathsTool.resolveExisting(root, key); } catch { return legacy; }
}
function stateWriteDir(root, key, legacyName) {
  const legacy = path.join(claudeDir(root), legacyName);
  if (!forgePathsTool) return legacy;
  try { return forgePathsTool.stateDir(root, key); } catch { return legacy; }
}
function runsDirOf(root) { return stateReadDir(root, 'runs', 'forge-runs'); }
/** memoryReadPath(root, name) -> where a FORGE_*.md memory file is read from (.claude/<name>, or .forge/memory/<name>
 *  with the legacy file as fallback until the new one exists). */
function memoryReadPath(root, name) {
  const legacy = path.join(claudeDir(root), name);
  if (!forgePathsTool) return legacy;
  try { return forgePathsTool.memoryFile(root, name, { read: true }); } catch { return legacy; }
}
/** relPosix(root, abs) -> the project-relative, forward-slash form shown to people (".claude/forge-scribe"). */
function relPosix(root, abs) { return path.relative(path.resolve(root), abs).split(path.sep).join('/'); }
function listByExt(dir, exts) {
  let out = []; let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { if (e.isFile() && exts.includes(path.extname(e.name))) out.push(path.join(dir, e.name)); }
  return out.sort();
}

module.exports = {
  store, BIN_DIR, policy, syncTool, verifyTool, runContractTool, skillEvalsTool, runwatchTool, contextBudgetTool,
  releaseCheckTool, shipcheckTool, regGenTool, skillLintTool, agentLintTool, configScanTool, harnessScoreTool, NODE,
  DASH_SPA, claudeDir, forgePathsTool, stateReadDir, stateWriteDir, runsDirOf, memoryReadPath, relPosix, listByExt,
};
