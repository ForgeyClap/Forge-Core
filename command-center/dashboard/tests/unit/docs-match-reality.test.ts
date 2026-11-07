/**
 * The project's own documents must agree with the code about checkable facts.
 *
 * `forge-docdrift.cjs` watches EXTERNAL sources — the Anthropic docs, the n8n docs — and reported
 * 11/11 OK while `CLAUDE.md`, the file every agent reads first and which outranks every other
 * instruction, described the WRONG dashboard as this project's own: the legacy Control Center on
 * port 3737–3999, and `/forge dashboard` as the thing that starts it. An agent following it would
 * have started the wrong process. Nothing was watching the inside.
 *
 * That was the third finding in a row of one class: text that names the wrong thing with complete
 * confidence — a component ("start the bridge"), an instruction (a relative command with no stated
 * directory), and then the governing document. None of them would trip a forbidden-word scan,
 * because none of them sounds fake. They are ordinary words for real things — just not the thing in
 * front of you.
 *
 * So this guard checks the claims themselves rather than adding a fourth one-off correction.
 *
 * Deliberately NARROW. A naive "every port in the docs must be 4100" would immediately cry wolf:
 * `.claude/commands/forge.md` legitimately cites `127.0.0.1:3100` for the Paperclip runtime, a
 * different opt-in subsystem. A guard that reports false alarms gets switched off, and then it
 * protects nothing — so this only checks claims that are *about the Command Center* and can be
 * settled against the code or the filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GATEWAY_ORIGIN, GATEWAY_START_COMMAND } from '@/prototype/state/gateway-client';

// C1 fix (2026-09-26 laptop re-audit): the old `resolve(process.cwd(), '..', '..')` assumed
// vitest is ALWAYS invoked with `command-center/dashboard` as cwd — true only for one specific
// invocation habit (the author's own `cd command-center/dashboard && npm test`), false for any other
// caller (a CI runner, `npm --prefix`, a worktree-based checkout, a different launcher script) —
// exactly the "only passes on the author's machine" class of defect. Walking upward from THIS
// file's own real, fixed on-disk location (never affected by cwd) for the nearest ancestor that
// contains the one stable marker every real checkout of this project ships
// (`command-center/gateway/bin.mjs`) is invocation-independent. Falls back to the original
// cwd-based guess only if that marker is genuinely never found (never worse than before).
function findProjectRoot(): string {
  const thisFileDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisFileDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'command-center', 'gateway', 'bin.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), '..', '..');
}

const PROJECT_ROOT = findProjectRoot();

/**
 * Where `CLAUDE.md` moved its dashboard detail (modernization WP 3.6, 2026-10-24: the always-loaded
 * file was cut under 6 KB and the dashboard section moved here word for word; `CLAUDE.md` points
 * here with "Detail: `docs/claude-md/dashboard.md`").
 */
const DASHBOARD_DETAIL_DOC = 'docs/claude-md/dashboard.md';

/** The documents that describe how to run this project. */
const DOCS = ['CLAUDE.md', join('.claude', 'commands', 'forge.md'), DASHBOARD_DETAIL_DOC];

const GATEWAY_ENTRY = 'command-center/gateway/bin.mjs';
const LEGACY_SERVER_MARKERS = ['.claude/forge-dashboard/server.cjs', 'server.cjs'];

function firstIndexOf(text: string, needles: readonly string[]): number {
  const hits = needles.map((needle) => text.indexOf(needle)).filter((index) => index > -1);
  return hits.length === 0 ? -1 : Math.min(...hits);
}

/**
 * Returns why `claudeMd` (with its dashboard detail doc) fails to present the Command Center as this
 * project's dashboard, or null when it does. The Command Center must be named by its real origin or
 * gateway entrypoint BEFORE any mention of the legacy server, in both files, and the gateway
 * entrypoint must be reachable: named in `CLAUDE.md` itself, or in the detail doc it points to.
 */
function dashboardClaimProblem(claudeMd: string, detailDoc: string, originHostPort: string): string | null {
  const anchors = [originHostPort, GATEWAY_ENTRY];
  const ccIndex = firstIndexOf(claudeMd, anchors);
  if (ccIndex === -1) return 'CLAUDE.md no longer names the Command Center (its origin or gateway entrypoint) at all';

  const legacyIndex = firstIndexOf(claudeMd, LEGACY_SERVER_MARKERS);
  if (legacyIndex > -1 && legacyIndex < ccIndex) {
    return 'CLAUDE.md describes the legacy Control Center before the Command Center';
  }

  if (claudeMd.includes(GATEWAY_ENTRY)) return null;
  if (!claudeMd.includes(DASHBOARD_DETAIL_DOC)) {
    return `CLAUDE.md names neither ${GATEWAY_ENTRY} nor the detail doc ${DASHBOARD_DETAIL_DOC}`;
  }
  const detailCc = detailDoc.indexOf(GATEWAY_ENTRY);
  if (detailCc === -1) return `${DASHBOARD_DETAIL_DOC} does not name ${GATEWAY_ENTRY}`;
  const detailLegacy = firstIndexOf(detailDoc, LEGACY_SERVER_MARKERS);
  if (detailLegacy > -1 && detailLegacy < detailCc) {
    return `${DASHBOARD_DETAIL_DOC} describes the legacy Control Center before the Command Center`;
  }
  return null;
}

function readDoc(relativePath: string): string {
  const full = join(PROJECT_ROOT, relativePath);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

describe('project docs agree with the code about the Command Center', () => {
  it('every doc that names the gateway start command names the real one', () => {
    for (const doc of DOCS) {
      const text = readDoc(doc);
      if (!text.includes('gateway/bin.mjs')) continue;
      expect(
        text,
        `${doc} mentions the gateway entrypoint but not the exact command the UI shows ("${GATEWAY_START_COMMAND}"). ` +
          'Two spellings of the same instruction is how a reader ends up running neither.',
      ).toContain(GATEWAY_START_COMMAND);
    }
  });

  it('every path those docs cite for the Command Center really exists', () => {
    // Only the paths that are load-bearing for starting it. A doc citing a file that moved is the
    // same defect as a UI citing one: an instruction that cannot be followed.
    const REQUIRED = ['command-center/gateway/bin.mjs', 'command-center/dashboard/dist'];
    const missing: string[] = [];

    for (const doc of DOCS) {
      const text = readDoc(doc);
      for (const path of REQUIRED) {
        if (!text.includes(path)) continue;
        if (!existsSync(resolve(PROJECT_ROOT, path))) missing.push(`${doc} cites ${path}, which does not exist`);
      }
    }

    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the origin the docs give for the Command Center is the origin the code uses', () => {
    const originHostPort = GATEWAY_ORIGIN.replace(/^https?:\/\//, '');

    for (const doc of DOCS) {
      const text = readDoc(doc);
      // Only look at docs that actually talk about this gateway — other subsystems have their own
      // ports and are none of this guard's business (see the header's Paperclip note).
      if (!text.includes('command-center/gateway')) continue;
      expect(
        text,
        `${doc} describes the Command Center gateway but never states its real origin ${originHostPort}.`,
      ).toContain(originHostPort);
    }
  });

  it('CLAUDE.md does not present the legacy Control Center as this project’s dashboard', () => {
    const text = readDoc('CLAUDE.md');
    if (text === '') return; // A project without this file is out of scope, not a failure.

    // The regression this pins: the Command Center must be named as this project's dashboard
    // BEFORE the legacy section, so a reader acting on the first answer acts on the right one.
    // Since WP 3.6 the short CLAUDE.md names it by origin and points to the detail doc for the
    // gateway entrypoint, so the check follows that pointer instead of demanding the literal path.
    const problem = dashboardClaimProblem(
      text,
      readDoc(DASHBOARD_DETAIL_DOC),
      GATEWAY_ORIGIN.replace(/^https?:\/\//, ''),
    );
    expect(problem, `${problem ?? ''}. A reader stops at the first answer; it must be the right dashboard.`).toBeNull();
  });

  it('the CLAUDE.md dashboard check still rejects the regressions it exists for', () => {
    const origin = GATEWAY_ORIGIN.replace(/^https?:\/\//, '');
    const detail = `Start it with node ${GATEWAY_ENTRY}. The old .claude/forge-dashboard/server.cjs was removed.`;
    const pointer = `Detail: \`${DASHBOARD_DETAIL_DOC}\`.`;

    // Legacy server named first: the original 2026 regression.
    expect(
      dashboardClaimProblem(`Dashboard: .claude/forge-dashboard/server.cjs on 3737. Also ${origin}. ${pointer}`, detail, origin),
    ).toMatch(/legacy Control Center before/);
    // No Command Center at all.
    expect(dashboardClaimProblem('Dashboard: see the docs.', detail, origin)).toMatch(/no longer names/);
    // Origin named, but the entrypoint is nowhere reachable.
    expect(dashboardClaimProblem(`Dashboard on ${origin}.`, detail, origin)).toMatch(/names neither/);
    // Pointer followed, but the detail doc lost the entrypoint or puts the legacy server first.
    expect(dashboardClaimProblem(`Dashboard on ${origin}. ${pointer}`, 'Use server.cjs.', origin)).toMatch(/does not name/);
    expect(
      dashboardClaimProblem(`Dashboard on ${origin}. ${pointer}`, `server.cjs first, then ${GATEWAY_ENTRY}`, origin),
    ).toMatch(/legacy Control Center before/);
    // Both accepted shapes: entrypoint inline, or origin plus pointer to a correct detail doc.
    expect(dashboardClaimProblem(`Run node ${GATEWAY_ENTRY} on ${origin}.`, '', origin)).toBeNull();
    expect(dashboardClaimProblem(`Dashboard on ${origin}; old server.cjs removed. ${pointer}`, detail, origin)).toBeNull();
  });
});
