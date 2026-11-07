/**
 * WP B5 part BUILD: the distributed-build flag, the forge-dist-strip plugin and the dist/ scan.
 * The real proof is `npm run build:dist` (see the WP report); these tests pin the decisions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IS_DIST_BUILD, isFeatureShipped } from '@/build-flags';
import { auditBundle, findForbidden, forgeDistStrip, isNeverShipModule, isStubbedView } from '../../scripts/dist-strip.mjs';
import { checkDistClean, EXIT, main } from '../../scripts/check-dist-clean.mjs';

const VIEW_WIN = 'C:\\x\\dashboard\\src\\views\\accounts\\AccountRotationView.tsx';
const ADAPTER = '/x/dashboard/src/prototype/state/adapter/account-rotation.ts';
const STUB = '/x/dashboard/src/views/accounts/dist-unavailable.tsx';

describe('build flags', () => {
  it('is not the distributed build under vitest, so the owner build keeps every feature', () => {
    expect(IS_DIST_BUILD).toBe(false);
    expect(isFeatureShipped('account-rotation')).toBe(true);
  });

  it('drops account rotation only in the distributed build', () => {
    expect(isFeatureShipped('account-rotation', true)).toBe(false);
    expect(isFeatureShipped('account-rotation', false)).toBe(true);
  });
});

describe('never-ship module ids', () => {
  it('matches the rotator view and adapter on Windows and POSIX paths, never the stand-in', () => {
    expect(isStubbedView(VIEW_WIN)).toBe(true);
    expect(isStubbedView('/x/dashboard/src/views/accounts/accounts.css?direct')).toBe(true);
    expect(isStubbedView(STUB)).toBe(false);
    expect(isNeverShipModule(ADAPTER)).toBe(true);
    expect(isNeverShipModule(STUB)).toBe(false);
    expect(isNeverShipModule('/x/dashboard/src/views/chat/ChatView.tsx')).toBe(false);
    expect(isNeverShipModule('/x/dashboard/src/components/usage/AccountUsagePressure.tsx')).toBe(false);
  });

  it('finds the forbidden text case-sensitively', () => {
    expect(findForbidden('x AccountRotationView y')).toEqual(['AccountRotation']);
    expect(findForbidden('gwGet("/api/account-rotation")')).toEqual(['account-rotation']);
    expect(findForbidden('accountRotation is a different word')).toEqual([]);
  });
});

describe('auditBundle', () => {
  it('reports a forbidden file name, a never-ship module and forbidden content', () => {
    const leaks = auditBundle({
      'assets/AccountRotationView-abc.js': { type: 'chunk', code: 'x', moduleIds: [VIEW_WIN] },
      'assets/index-1.js': { type: 'chunk', code: 'fetch("/api/account-rotation")', moduleIds: [ADAPTER] },
      'assets/accounts-2.css': { type: 'asset', source: new TextEncoder().encode('.AccountRotation{}') },
    });
    expect(leaks.map((l) => l.file + ' | ' + l.reason)).toEqual([
      'assets/AccountRotationView-abc.js | file name contains AccountRotation',
      'assets/AccountRotationView-abc.js | bundles never-ship module AccountRotationView.tsx',
      'assets/index-1.js | bundles never-ship module account-rotation.ts',
      'assets/index-1.js | content contains account-rotation',
      'assets/accounts-2.css | content contains AccountRotation',
    ]);
  });

  it('passes a clean bundle that only holds the stand-in', () => {
    expect(auditBundle({ 'assets/dist-unavailable-1.js': { type: 'chunk', code: 'export{}', moduleIds: [STUB] } })).toEqual([]);
  });
});

describe('forgeDistStrip plugin', () => {
  type Ctx = { resolve: (s: string, i?: string, o?: object) => Promise<{ id: string } | null>; error: (m: string) => never };
  const ctx = (id: string | null): Ctx => ({
    resolve: async () => (id ? { id } : null),
    error: (m: string) => { throw new Error(m); },
  });
  const hook = (p: ReturnType<typeof forgeDistStrip>, name: 'resolveId' | 'generateBundle') =>
    (p as unknown as Record<string, (...a: unknown[]) => unknown>)[name];

  it('redirects the rotator view to the stand-in only when enabled', async () => {
    const on = forgeDistStrip({ enabled: true, stubPath: STUB });
    const off = forgeDistStrip({ enabled: false, stubPath: STUB });
    expect(await hook(on, 'resolveId').call(ctx(VIEW_WIN), '@/views/accounts/AccountRotationView', 'App.tsx', {})).toBe(STUB);
    expect(await hook(on, 'resolveId').call(ctx('/x/src/views/chat/ChatView.tsx'), '@/views/chat/ChatView', 'App.tsx', {})).toBeNull();
    expect(await hook(off, 'resolveId').call(ctx(VIEW_WIN), '@/views/accounts/AccountRotationView', 'App.tsx', {})).toBeNull();
  });

  it('fails the build when never-ship code still reaches the output (fail closed)', () => {
    const on = forgeDistStrip({ enabled: true, stubPath: STUB });
    const leaky = { 'assets/index.js': { type: 'chunk', code: '"/api/account-rotation"', moduleIds: [] } };
    expect(() => hook(on, 'generateBundle').call(ctx(null), {}, leaky)).toThrow(/development-only code reached the distributed build/);
    expect(() => hook(forgeDistStrip({ enabled: false, stubPath: STUB }), 'generateBundle').call(ctx(null), {}, leaky)).not.toThrow();
  });
});

describe('check-dist-clean', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-1.js'), 'console.info(1)');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { out: () => {}, err: () => {} };

  it('exits 0 on a clean folder', () => {
    expect(checkDistClean(dir)).toMatchObject({ scanned_files: 2, findings: [], exit_code: EXIT.CLEAN });
    expect(main([dir], quiet)).toBe(0);
  });

  it('exits 3 on a forbidden file name or content', () => {
    fs.writeFileSync(path.join(dir, 'assets', 'AccountRotationView-x.js'), 'ok');
    fs.writeFileSync(path.join(dir, 'assets', 'index-2.js'), 'get("/api/account-rotation")');
    const r = checkDistClean(dir);
    expect(r.findings).toEqual([
      { file: 'assets/AccountRotationView-x.js', needle: 'AccountRotation', where: 'name' },
      { file: 'assets/index-2.js', needle: 'account-rotation', where: 'content' },
    ]);
    expect(r.exit_code).toBe(EXIT.FINDINGS);
    expect(main([dir], quiet)).toBe(3);
  });

  it('exits 2 (fail closed) on a missing or empty folder and on an unknown option', () => {
    expect(main([path.join(dir, 'nope')], quiet)).toBe(2);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-empty-'));
    try { expect(main([empty], quiet)).toBe(2); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
    expect(main(['--bogus'], quiet)).toBe(2);
  });
});
