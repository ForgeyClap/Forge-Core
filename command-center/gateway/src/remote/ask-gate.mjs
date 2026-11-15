// Which pending asks the phone may answer (contract 4.4/4.5/6). An ask is DASHBOARD-ONLY, shown
// read-only on the phone and refused there with 403 dashboard_only, when:
//   - bypass_turn            it comes from a turn that asked for bypass mode (full access);
//   - hard_gate              a question or option matches Forge's hard-gate classifier
//                            (forge-actiongate.cjs over hard-gates.json: deploy, push, spend, DNS,
//                            production, credentials, outbound, delete, ...);
//   - unknown_turn           its turn cannot be found (fail closed);
//   - classifier_unavailable the gateway's own classifier copy did not load (fail closed).
// The classifier is the gateway's CENTRAL copy under PROJECT_ROOT, never a project's own copy.
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../paths.mjs';
import { readConversation } from '../conversations.mjs';

const require = createRequire(import.meta.url);
const CLASSIFIER = path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-actiongate.cjs');

let override; // undefined = the real classifier; null = "could not load"; a function = test stand-in
let loaded; // undefined = not tried yet; null = failed; otherwise classify()

/** The loaded classify() of forge-actiongate.cjs, or null when it did not load. Shared with
 *  permissions/hard-gate.mjs so asks and permission cards use one classifier. */
export function actionGateClassifier() {
  return classifier();
}

function classifier() {
  if (override !== undefined) return override;
  if (loaded === undefined) {
    try {
      const m = require(CLASSIFIER);
      loaded = m && typeof m.classify === 'function' ? m.classify : null;
    } catch (err) {
      console.error('remote bridge: hard-gate classifier did not load (every ask is dashboard-only): ' + (err && err.message ? err.message : err));
      loaded = null;
    }
  }
  return loaded;
}

function optionText(o) {
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') return [o.label, o.description].filter((x) => typeof x === 'string').join(' ');
  return '';
}

/** Every text of one question the owner would be approving: header, question and each option. */
export function questionTexts(q) {
  if (!q || typeof q !== 'object') return [];
  return [q.header, q.question, ...(Array.isArray(q.options) ? q.options.map(optionText) : [])]
    .filter((t) => typeof t === 'string' && t.trim().length > 0);
}

/** The requested mode of the ask's turn (or, without a turn id, of the latest user turn); null when unknown. */
function turnMode(convId, turnId) {
  try {
    const conv = readConversation(convId);
    if (!conv.ok) return null;
    const users = conv.turns.filter((t) => t.role === 'user');
    const turn = turnId ? users.find((t) => t.turn_id === turnId) : users[users.length - 1];
    return turn && typeof turn.mode === 'string' ? turn.mode : null;
  } catch {
    return null;
  }
}

function matchesHardGate(classify, questions) {
  for (const q of questions || []) {
    for (const text of questionTexts(q)) if (classify(text).gate === true) return true;
  }
  return false;
}

/** `{ dashboardOnly, reason }` for one pending ask `{ convId, turnId, questions }`. Never throws. */
export function askDashboardOnly(meta) {
  const mode = turnMode(meta.convId, meta.turnId);
  if (mode === null) return { dashboardOnly: true, reason: 'unknown_turn' };
  if (mode === 'bypass') return { dashboardOnly: true, reason: 'bypass_turn' };
  const classify = classifier();
  if (typeof classify !== 'function') return { dashboardOnly: true, reason: 'classifier_unavailable' };
  try {
    if (matchesHardGate(classify, meta.questions)) return { dashboardOnly: true, reason: 'hard_gate' };
  } catch {
    return { dashboardOnly: true, reason: 'classifier_unavailable' };
  }
  return { dashboardOnly: false, reason: null };
}

/** Test-only: a classify stand-in, null for "could not load", undefined for the real one. */
export function _setActionGateForTests(fn) { override = fn; }
