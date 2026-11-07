/**
 * Redesign, part 1A (Forge Systeem v1.0): tokens, theme and the alias bridge.
 *
 * - Every v1.0 token from docs/forge-systeem/redesign/tokens.css exists in brand/forge-tokens.css, with the same value,
 *   in both themes (the table below mirrors that file; the redesign folder is outside this git repo).
 * - (4B): the alias bridge for the old `--forge-*` and v0.1 `--fs-*` names is deleted. Every `--fs-*` name src/**
 *   uses is a v1.0 token, and no file under src/** names `--forge-` at all (ceiling 0, comments included).
 * - No raw hex outside brand/ (ratchet: the known legacy files may only shrink; their owners clear them in).
 * - index.html sets data-theme before first paint, defaults to light and still follows "Zoals Windows".
 * - app.css and forge-base.css: no hex, no old names, motion on transform/opacity only, reduced motion respected.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = join(ROOT, 'brand');
const SRC = join(ROOT, 'src');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** The declarations of the first block whose selector line is exactly `selector {`. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {\n`);
  expect(start, `block "${selector}" missing in forge-tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** v1.0 colour tokens, light then dark (docs/forge-systeem/redesign/tokens.css). */
const V1: Record<string, [string, string]> = {
  'fs-bg': ['#F4F7F7', '#131B1C'],
  'fs-bg-side': ['#EAEFEF', '#0F1617'],
  'fs-surface': ['#FFFFFF', '#1A2324'],
  'fs-surface-2': ['#F9FBFB', '#1F292A'],
  'fs-sunken': ['#E3E9E9', '#243031'],
  'fs-line': ['#D6DEDE', '#2A3738'],
  'fs-line-strong': ['#7E8E8F', '#5F7273'],
  'fs-ink': ['#142021', '#E6EDED'],
  'fs-ink-2': ['#465556', '#AAB7B7'],
  'fs-ink-3': ['#56666A', '#8E9C9C'],
  'fs-ink-on-accent': ['#FFFFFF', '#0C1718'],
  'fs-accent': ['#17606E', '#63BAC6'],
  'fs-accent-hover': ['#124F5B', '#7CC8D2'],
  'fs-accent-active': ['#0D3F49', '#4FA6B2'],
  'fs-accent-text': ['#145A67', '#76C4CE'],
  'fs-accent-soft': ['#DCECEE', '#1C3639'],
  'fs-accent-line': ['#8DBAC1', '#3D7A83'],
  'fs-ok': ['#2A6B47', '#74C796'],
  'fs-ok-soft': ['#DFEFE5', '#183024'],
  'fs-warn': ['#865600', '#E2B460'],
  'fs-warn-soft': ['#F6EACD', '#332A14'],
  'fs-danger': ['#A6372D', '#EE8D80'],
  'fs-danger-soft': ['#F8E2DE', '#3A201C'],
  'fs-info': ['#3A5889', '#9AB3DE'],
  'fs-info-soft': ['#E2E9F4', '#1E2839'],
};
const V1_THEMED_EXTRA = ['fs-shadow-1', 'fs-shadow-2', 'fs-shadow-3', 'fs-scrim'];

/** v1.0 theme-independent tokens. */
const V1_GLOBAL = [
  'fs-font-display', 'fs-font-body', 'fs-font-mono',
  'fs-text-12', 'fs-text-13', 'fs-text-14', 'fs-text-15', 'fs-text-18', 'fs-text-22', 'fs-text-30', 'fs-text-40',
  'fs-leading-body', 'fs-leading-snug', 'fs-leading-tight', 'fs-track-display',
  ...Array.from({ length: 10 }, (_, i) => `fs-space-${i + 1}`),
  'fs-radius-xs', 'fs-radius-sm', 'fs-radius-md', 'fs-radius-lg', 'fs-radius-pill', 'fs-radius-struck',
  'fs-sidebar', 'fs-column', 'fs-column-wide', 'fs-control-sm', 'fs-control-md', 'fs-touch',
  'fs-focus', 'fs-ease', 'fs-ease-spring', 'fs-dur-1', 'fs-dur-2', 'fs-dur-3',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const SRC_FILES = walk(SRC);
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every --fs-* name src/** uses outside comments (greedy; a name ending in '-' is built at runtime and skipped). */
function fsNamesUsed(): Set<string> {
  const out = new Set<string>();
  for (const f of SRC_FILES) for (const m of stripComments(read(f)).matchAll(/--(fs-[a-z0-9-]+)/g)) if (!m[1].endsWith('-')) out.add(m[1]);
  return out;
}

const css = read(join(BRAND, 'forge-tokens.css'));

describe('v1.0 tokens exist in both themes with the v1.0 values', () => {
  it('light is the default block, dark has its own block and a no-preference media block', () => {
    const light = block(css, ':root, [data-theme="light"]');
    const dark = block(css, '[data-theme="dark"]');
    const darkNoAttr = block(css, '  :root:not([data-theme])');
    for (const [name, [l, d]] of Object.entries(V1)) {
      expect(light[name]?.toUpperCase(), `${name} light`).toBe(l);
      expect(dark[name]?.toUpperCase(), `${name} dark`).toBe(d);
      expect(darkNoAttr[name]?.toUpperCase(), `${name} dark (system, no attribute)`).toBe(d);
    }
    for (const name of V1_THEMED_EXTRA) {
      expect(light[name], `${name} light`).toBeTruthy();
      expect(dark[name], `${name} dark`).toBeTruthy();
    }
  });

  it('the theme-independent tokens are defined once in :root', () => {
    const globals = block(css, ':root');
    for (const name of V1_GLOBAL) expect(globals[name], name).toBeTruthy();
    expect(globals['fs-radius-struck']).toBe('20px 5px 20px 20px');
    expect(globals['fs-font-display']).toMatch(/^'Bahnschrift'/);
    expect(globals['fs-font-body']).toMatch(/^'Segoe UI Variable Text', 'Segoe UI'/);
  });

  it('reduced motion sets every duration to 0', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf('}', at));
    for (const d of ['fs-dur-1', 'fs-dur-2', 'fs-dur-3']) expect(body).toContain(`--${d}: 0ms;`);
  });

  it('tokens.json and forge-tokens.css are in sync (build-theme --check)', () => {
    const out = execFileSync(process.execPath, [join(BRAND, 'build-theme.cjs'), '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/tokens in sync/);
  });
});

describe('the alias bridge is gone (wave 4)', () => {
  it('forge-tokens.css defines no old --forge-* name and no alias block', () => {
    expect(css).not.toMatch(/--forge-/);
    expect(css).not.toContain(':root, [data-theme] {');
  });

  it('tokens.json has no bridge block', () => {
    const tokens = JSON.parse(read(join(BRAND, 'tokens.json'))) as Record<string, unknown>;
    expect(Object.keys(tokens)).not.toContain('bridge');
  });

  it('every --fs-* name used in src/** is a v1.0 token', () => {
    const defined = new Set(Object.keys({ ...block(css, ':root'), ...block(css, ':root, [data-theme="light"]') }));
    const missing = [...fsNamesUsed()].filter((n) => !defined.has(n));
    expect(missing, `undefined: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * Raw hex outside brand/ is a ratchet. The parts (2C settings and accounts, 2D onboarding) brought every
 * legacy file to 0 (measured 2026-11-03 at the merge with this test's own regex), so no file may hold any.
 * Re-measured at the merge: still 0 in src/**.
 */
const LEGACY_HEX: Record<string, number> = {};

describe('no raw hex outside brand/', () => {
  it('only the known legacy files hold hex, and never more than today', () => {
    const over: string[] = [];
    for (const f of SRC_FILES) {
      const hits = stripComments(read(f)).match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/g) ?? [];
      const allowed = LEGACY_HEX[rel(f)] ?? 0;
      if (hits.length > allowed) over.push(`${rel(f)}: ${hits.length} > ${allowed}`);
    }
    expect(over).toEqual([]);
  });

  it('app.css, index.html and forge-base.css hold no hex and no old --forge-* name', () => {
    for (const p of ['src/styles/app.css', 'brand/forge-base.css']) {
      const text = stripComments(read(join(ROOT, p)));
      expect(text, p).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, p).not.toMatch(/--forge-/);
    }
    expect(read(join(ROOT, 'index.html'))).not.toMatch(/--forge-/);
  });
});

describe('no old --forge-* name in src/** (wave 4: ceiling 0)', () => {
  /** Every `--forge-` in a source file, comments included, so a stale reference cannot hide in a note. */
  const FORGE_NAME = /--forge-[\w-]*/g;
  function forgeNames(files: readonly string[]): string[] {
    return files.flatMap((f) => (read(f).match(FORGE_NAME) ?? []).map((m) => `${rel(f)}: ${m}`));
  }

  it('src/** names no --forge- token anywhere', () => {
    expect(forgeNames(SRC_FILES)).toEqual([]);
  });

  it('the scan sees a --forge- name in code and in a comment, and not a BEM modifier', () => {
    expect('a { color: var(--forge-color-text); }'.match(FORGE_NAME)).toEqual(['--forge-color-text']);
    expect('/* the --forge-status-* tokens */'.match(FORGE_NAME)).toEqual(['--forge-status-']);
    expect('.fw-chat-msg--forge .x {}'.match(FORGE_NAME)).toBeNull();
  });
});

describe('motion: transform and opacity only, reduced motion respected', () => {
  for (const p of ['src/styles/app.css', 'brand/forge-base.css']) {
    it(`${p} only transitions transform and opacity`, () => {
      const text = stripComments(read(join(ROOT, p)));
      expect(text).not.toMatch(/transition:\s*all|transition-property:\s*(?!transform|opacity)/);
      for (const m of text.matchAll(/transition:\s*([^;]+);/g)) {
        if (m[1].trim() === 'none' || m[1].includes('!important')) continue;
        for (const part of m[1].split(',')) expect(part.trim().split(/\s+/)[0], `${p}: ${m[0]}`).toMatch(/^(transform|opacity)$/);
      }
      expect(text).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    });
  }

  it('no ALL CAPS in the shared base layer', () => {
    expect(stripComments(read(join(BRAND, 'forge-base.css')))).not.toMatch(/text-transform:\s*uppercase/);
  });
});

describe('logo files are in brand/', () => {
  for (const f of ['forge-mark.svg', 'forge-mark-on-dark.svg', 'forge-mark-mono.svg']) {
    it(f, () => expect(existsSync(join(BRAND, f))).toBe(true));
  }
});

/** Runs the real first-paint script from index.html against a fake browser. */
function firstPaint(opts: { stored?: string | null; osDark?: boolean | null; storageThrows?: boolean }): string | null {
  const html = read(join(ROOT, 'index.html'));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html);
  expect(script, 'inline first-paint script missing').not.toBeNull();
  let theme: string | null = null;
  const documentFake = { documentElement: { setAttribute: (k: string, v: string) => { if (k === 'data-theme') theme = v; } } };
  const localStorageFake = {
    getItem: () => {
      if (opts.storageThrows) throw new Error('storage disabled');
      return opts.stored ?? null;
    },
  };
  const windowFake =
    opts.osDark === null
      ? {}
      : { matchMedia: (q: string) => ({ matches: q.includes('dark') ? !!opts.osDark : q.includes('light') ? false : false }) };
  new Function('window', 'document', 'localStorage', (script as RegExpExecArray)[1])(windowFake, documentFake, localStorageFake);
  return theme;
}

describe('index.html: theme set before paint, light by default, Windows respected', () => {
  it('the attribute default in the markup is light', () => {
    expect(read(join(ROOT, 'index.html'))).toMatch(/<html lang="nl" data-theme="light">/);
  });
  it('no stored choice and Windows dark -> dark', () => expect(firstPaint({ osDark: true })).toBe('dark'));
  it('no stored choice and Windows light or no preference -> light', () => expect(firstPaint({ osDark: false })).toBe('light'));
  it('a stored choice wins', () => {
    expect(firstPaint({ stored: 'dark', osDark: false })).toBe('dark');
    expect(firstPaint({ stored: 'light', osDark: true })).toBe('light');
    expect(firstPaint({ stored: 'system', osDark: true })).toBe('dark');
  });
  it('storage or matchMedia failing falls back to light', () => {
    expect(firstPaint({ storageThrows: true, osDark: true })).toBe('light');
    expect(firstPaint({ osDark: null })).toBe('light');
  });
});
