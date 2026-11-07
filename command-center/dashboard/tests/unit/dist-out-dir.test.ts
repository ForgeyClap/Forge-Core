/**
 * FORGE_DIST_OUT_DIR fail-closed guard (Lead integration of WP B5 part BUILD, Review Boss finding 2026-11-02).
 *
 * `vite build --mode dist` empties FORGE_DIST_OUT_DIR before writing. These cases pin the rule that a folder is
 * only accepted when emptying it cannot destroy anything but a build output: scratch/temp folders, folders that do
 * not exist yet, or folders holding only a previous Vite build. Everything else must throw before Vite runs.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { resolveDistOutDir } from '../../scripts/dist-out-dir.mjs';

const PROJECT = path.resolve('/work/project');
const CC = path.join(PROJECT, 'command-center');
const TMP = path.resolve('/tmp-root');

type FakeEntry = { dir: boolean; entries?: string[] };

function fakeFs(tree: Record<string, FakeEntry>) {
  const norm = (p: string) => path.resolve(p);
  return {
    existsSync: (p: string) => norm(p) in tree,
    statSync: (p: string) => ({ isDirectory: () => tree[norm(p)].dir }),
    readdirSync: (p: string) => tree[norm(p)].entries ?? [],
  };
}

const base = { projectRoot: PROJECT, commandCenterRoot: CC, tmpDir: TMP, cwd: path.join(CC, 'dashboard') };

describe('resolveDistOutDir', () => {
  it('returns null when the variable is unset or blank (Vite default outDir applies)', () => {
    expect(resolveDistOutDir(undefined, { ...base, fs: fakeFs({}) })).toBeNull();
    expect(resolveDistOutDir('   ', { ...base, fs: fakeFs({}) })).toBeNull();
  });

  it('accepts folders under the project _scratch, the command-center _scratch and the temp folder, even when they hold other files', () => {
    const scratch = path.join(PROJECT, '_scratch', 'b5', 'build');
    const ccScratch = path.join(CC, '_scratch', 'x');
    const tmp = path.join(TMP, 'forge-dist');
    const fs = fakeFs({
      [scratch]: { dir: true, entries: ['notes.md', 'index.html'] },
      [ccScratch]: { dir: true, entries: ['anything'] },
      [tmp]: { dir: true, entries: ['a', 'b'] },
    });
    expect(resolveDistOutDir(scratch, { ...base, fs })).toBe(scratch);
    expect(resolveDistOutDir(ccScratch, { ...base, fs })).toBe(ccScratch);
    expect(resolveDistOutDir(tmp, { ...base, fs })).toBe(tmp);
  });

  it('accepts a folder that does not exist yet and an empty folder', () => {
    const fresh = path.resolve('/elsewhere/new-dist');
    const empty = path.resolve('/elsewhere/empty');
    const fs = fakeFs({ [empty]: { dir: true, entries: [] } });
    expect(resolveDistOutDir(fresh, { ...base, fs })).toBe(fresh);
    expect(resolveDistOutDir(empty, { ...base, fs })).toBe(empty);
  });

  it('accepts a folder that holds only a previous Vite build', () => {
    const prev = path.resolve('/elsewhere/dist');
    const fs = fakeFs({ [prev]: { dir: true, entries: ['index.html', 'assets', '.vite'] } });
    expect(resolveDistOutDir(prev, { ...base, fs })).toBe(prev);
  });

  it('refuses the command-center root given as ".." from dashboard/ (the folder the review named)', () => {
    const fs = fakeFs({ [CC]: { dir: true, entries: ['dashboard', 'gateway', 'desktop', 'README.md'] } });
    expect(() => resolveDistOutDir('..', { ...base, fs })).toThrow(/refused/);
    expect(() => resolveDistOutDir('..', { ...base, fs })).toThrow(/dashboard/);
  });

  it('refuses a folder with any entry that is not part of a Vite build, and a path that is a file', () => {
    const mixed = path.resolve('/elsewhere/mixed');
    const file = path.resolve('/elsewhere/file.txt');
    const fs = fakeFs({
      [mixed]: { dir: true, entries: ['index.html', 'assets', 'my-photos'] },
      [file]: { dir: false },
    });
    expect(() => resolveDistOutDir(mixed, { ...base, fs })).toThrow(/my-photos/);
    expect(() => resolveDistOutDir(file, { ...base, fs })).toThrow(/not a folder/);
  });

  it('refuses a non-empty folder with only assets/ but no index.html (half a build is not proof of ours)', () => {
    const half = path.resolve('/elsewhere/half');
    const fs = fakeFs({ [half]: { dir: true, entries: ['assets'] } });
    expect(() => resolveDistOutDir(half, { ...base, fs })).toThrow(/refused/);
  });
});
