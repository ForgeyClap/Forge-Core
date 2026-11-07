/**
 * onboarding-model — the first-start wizard's rules (WP B6, plan §4.7 and §3.2). Pure, so the step
 * flow, the per-path capability table and the folder guardrails are unit-tested without React.
 */

import type { CheckupResult } from '@/components/checkup/checkup-model';

/**
 * The four steps of DESIGN.md §3.5: Welkom (`detectie`, the silent pc check), Kies (`pad`), Verbinden,
 * Klaar (`klaar`, which now also holds the project folder). The ids stay the old ones so existing
 * callers and fixtures keep working; the visible names come from `rd.onboarding.steps.*`.
 */
export const STEPS = ['detectie', 'pad', 'verbinden', 'klaar'] as const;
export type StepId = (typeof STEPS)[number];

/** The old fifth step. It still opens: on Klaar, with the folder picker already open. */
export type LegacyStepId = StepId | 'projectmap';

export function normaliseStep(step: LegacyStepId): StepId {
  return step === 'projectmap' ? 'klaar' : step;
}

/** The four choices on step 2. "Eigen sleutel of server" covers both the key path and the own-API path. */
export const CHOICES = ['claude', 'chatgpt', 'lokaal', 'eigen-sleutel'] as const;
export type ChoiceId = (typeof CHOICES)[number];

export function choiceForPath(path: PathId | null): ChoiceId | null {
  if (path === null) return null;
  return path === 'sleutel' || path === 'eigen' ? 'eigen-sleutel' : path;
}

/** The path a choice opens. The own choice keeps the own-API form when that was already open. */
export function pathForChoice(choice: ChoiceId, current: PathId | null): PathId {
  if (choice !== 'eigen-sleutel') return choice;
  return current === 'eigen' ? 'eigen' : 'sleutel';
}

/** The four paths of plan §3.2, plus `eigen` (ANY-MODEL-PLAN.md §2.2 E): an own server or a service that is not listed. */
export const PATHS = ['claude', 'chatgpt', 'lokaal', 'sleutel', 'eigen'] as const;
export type PathId = (typeof PATHS)[number];

export function isPathId(value: unknown): value is PathId {
  return typeof value === 'string' && (PATHS as readonly string[]).includes(value);
}

/** One cell of the table in plan §3.2: yes/no plus the optional remark in brackets. */
export interface Capability {
  readonly yes: boolean;
  readonly remark?: 'readOnly' | 'notYet' | 'ifOwnServer';
}

export interface CapabilityRow {
  readonly path: PathId;
  readonly chat: Capability;
  readonly files: Capability;
  readonly team: Capability;
  readonly offline: Capability;
}

/**
 * Plan §3.2 "Capaciteit per pad", with two honest corrections (ANY-MODEL-PLAN.md §7): Codex reads and
 * answers in Forge but does not edit files in your folder (the same sentence as the chat notice), and the
 * own-API row works offline only when the server is on your own pc or network. Copy: `onboarding.table.*`.
 */
export const CAPABILITY_TABLE: readonly CapabilityRow[] = [
  { path: 'claude', chat: { yes: true }, files: { yes: true }, team: { yes: true }, offline: { yes: false } },
  { path: 'chatgpt', chat: { yes: true }, files: { yes: false, remark: 'readOnly' }, team: { yes: false }, offline: { yes: false } },
  { path: 'lokaal', chat: { yes: true }, files: { yes: false, remark: 'notYet' }, team: { yes: false }, offline: { yes: true } },
  { path: 'sleutel', chat: { yes: true }, files: { yes: false }, team: { yes: false }, offline: { yes: false } },
  { path: 'eigen', chat: { yes: true }, files: { yes: false }, team: { yes: false }, offline: { yes: true, remark: 'ifOwnServer' } },
];

export function capabilitiesFor(path: PathId): CapabilityRow {
  return CAPABILITY_TABLE.find((row) => row.path === path) ?? CAPABILITY_TABLE[0];
}

export function nextStep(step: StepId): StepId {
  const index = STEPS.indexOf(step);
  return STEPS[Math.min(STEPS.length - 1, index + 1)];
}

/**
 * May "Verder" be pressed? Welkom waits for the pc check; Kiezen and Verbinden need a path; the Eigen API
 * path on Verbinden also needs a saved own API (Review Boss, Q5-EIGEN-API-UI): an empty form is no path.
 */
export function canContinueStep(step: StepId, checkup: string, path: PathId | null, ownApiReady: boolean): boolean {
  if (step === 'detectie') return checkup === 'done' || checkup === 'failed';
  if (step === 'verbinden' && path === 'eigen') return ownApiReady;
  return step === 'pad' || step === 'verbinden' ? path !== null : true;
}

export function previousStep(step: StepId): StepId {
  const index = STEPS.indexOf(step);
  return STEPS[Math.max(0, index - 1)];
}

/**
 * Welkom shows only a real problem with this pc (DESIGN.md §3.5): too little disk, or a project
 * folder Forge may not write in. Claude, Codex and Ollama are not problems here: they belong to a
 * path and are handled on Verbinden. A check that could not tell is not a problem either.
 */
export function isPcProblem(row: { readonly id: string; readonly state: string }): boolean {
  return row.state === 'fail' && (row.id === 'disk' || row.id === 'folder' || row.id === 'node');
}

/* --------------------------------------------------------- first start */

export const ONBOARDING_DONE_KEY = 'forge.onboarding.done';
export const ONBOARDING_PATH_KEY = 'forge.onboarding.path';
export const ONBOARDING_FOLDER_KEY = 'forge.onboarding.projectDir';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* Not remembered when storage is unavailable; the wizard simply shows again next time. */
  }
}

export function isOnboardingDone(): boolean {
  return read(ONBOARDING_DONE_KEY) === '1';
}

export function markOnboardingDone(path: PathId | null, folder: string | null): void {
  write(ONBOARDING_DONE_KEY, '1');
  if (path) write(ONBOARDING_PATH_KEY, path);
  if (folder) write(ONBOARDING_FOLDER_KEY, folder);
}

export function readChosenFolder(): string | null {
  return read(ONBOARDING_FOLDER_KEY);
}

/**
 * Should the app send this user to /onboarding? Only on a first start (no flag) AND only when the
 * checkup really answered and Claude Code is not yet found-and-signed-in. A user who already has a
 * working Claude Code (the owner, every existing install) is never pushed into the wizard; a
 * gateway that does not answer (tests, a broken start) never triggers it either.
 */
export function shouldStartOnboarding(
  doneFlag: boolean,
  checkup: { readonly claude: { readonly found: boolean; readonly signedIn: boolean | null } } | null,
): boolean {
  if (doneFlag || checkup === null) return false;
  return !(checkup.claude.found && checkup.claude.signedIn === true);
}

/* ------------------------------------------------------- folder rules */

export type FolderRefusal = 'root' | 'home' | 'documents' | 'system';

const SYSTEM_PARTS = [/\\windows(\\|$)/i, /\\program files( \(x86\))?(\\|$)/i, /\\programdata(\\|$)/i];

function trimSlashes(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/**
 * The guardrails from plan §3.2: never a drive root, the whole user folder, the Documents root or a
 * Windows/program folder. `documentsRoot` is the folder the picker opens on (the user's own
 * Documents), its parent is the user folder.
 */
export function folderRefusal(path: string, documentsRoot: string | null): FolderRefusal | null {
  const clean = trimSlashes(path.trim());
  if (/^[A-Za-z]:$/.test(clean) || clean === '' || clean === '/') return 'root';
  if (SYSTEM_PARTS.some((pattern) => pattern.test(clean))) return 'system';
  if (documentsRoot) {
    const docs = trimSlashes(documentsRoot).toLowerCase();
    const home = docs.replace(/[\\/][^\\/]+$/, '');
    const lower = clean.toLowerCase();
    if (lower === docs) return 'documents';
    if (lower === home) return 'home';
  }
  return null;
}

/** The path that fits what the checkup found, so the likely answer is already selected. */
export function suggestPath(result: CheckupResult | null): PathId | null {
  if (!result) return null;
  if (result.claude.found) return 'claude';
  if (result.ollama.up) return 'lokaal';
  if (result.codex.found) return 'chatgpt';
  return null;
}

