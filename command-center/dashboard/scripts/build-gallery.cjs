#!/usr/bin/env node
/**
 * build-gallery.cjs — turns artifacts/screenshots/*.png into a single visual
 * review page at artifacts/visual-review.html.
 *
 * Zero dependencies, same house style as brand/build-theme.cjs. The page pulls
 * its colours from the generated token stylesheet, so the review page is itself
 * a check that the theme holds up.
 *
 *   node scripts/build-gallery.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'artifacts', 'screenshots');
const OUT = path.join(ROOT, 'artifacts', 'visual-review.html');

function fail(msg) {
  process.stderr.write(`build-gallery: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SHOTS_DIR)) {
  fail(`no screenshots yet at ${path.relative(ROOT, SHOTS_DIR)}. Run: npm run shots`);
}

const files = fs
  .readdirSync(SHOTS_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort();

if (files.length === 0) fail('screenshots directory is empty. Run: npm run shots');

/**
 * "03-dark-project-overview-desktop.png"            -> { n, theme, mode: 'eenvoudig', viewport: 'desktop' }
 * "24-light-start-360-mobile-uitgebreid.png"        -> { n, theme, mode: 'uitgebreid', viewport: 'mobile' }
 * A `-uitgebreid` suffix marks the separate Uitgebreid pass; everything else is Eenvoudig, the app
 * default a beginner sees (tests/e2e/screenshots.spec.ts, POL-C).
 */
function describe(file) {
  const base = file.replace(/\.png$/, '');
  const advanced = /-uitgebreid$/.test(base);
  const [n, theme, ...rest] = base.replace(/-uitgebreid$/, '').split('-');
  const slug = rest.join('-');
  const viewport = /mobile$/.test(slug) ? 'mobile' : /desktop$/.test(slug) ? 'desktop' : 'full page';
  const title = slug
    .replace(/-(desktop|mobile)$/, '')
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
  return { n, theme, mode: advanced ? 'uitgebreid' : 'eenvoudig', title, viewport, file };
}

const shots = files.map(describe);
const groups = [
  { theme: 'dark', mode: 'eenvoudig', label: 'Dark theme, Eenvoudig (default)' },
  { theme: 'light', mode: 'eenvoudig', label: 'Light theme, Eenvoudig (default)' },
  { theme: 'dark', mode: 'uitgebreid', label: 'Dark theme, Uitgebreid' },
  { theme: 'light', mode: 'uitgebreid', label: 'Light theme, Uitgebreid' },
];

const stamp = fs.statSync(path.join(SHOTS_DIR, files[files.length - 1])).mtime.toISOString().slice(0, 16).replace('T', ' ');

const sections = groups
  .map((g) => {
    const items = shots.filter((s) => s.theme === g.theme && s.mode === g.mode);
    if (items.length === 0) return '';
    const cards = items
      .map(
        (s) => `
        <figure class="shot" id="shot-${s.file.replace(/\.png$/, '')}">
          <figcaption>
            <span class="idx fg-machine">${s.n}</span>
            <span class="title">${s.title}</span>
            <span class="meta fg-machine">${s.viewport}</span>
          </figcaption>
          <a href="screenshots/${s.file}" target="_blank" rel="noreferrer">
            <img src="screenshots/${s.file}" alt="${s.title}, ${g.label}, ${s.viewport}" loading="lazy" />
          </a>
        </figure>`,
      )
      .join('');
    return `<section><h2>${g.label} <span class="count fg-machine">${items.length}</span></h2>
      <div class="grid">${cards}</div></section>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forge Workspace — visual review</title>
<link rel="stylesheet" href="../brand/forge-tokens.css" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--fs-space-7) var(--fs-space-6) 5rem;
    background: var(--fs-bg-side);
    color: var(--fs-ink);
    font-family: var(--fs-font-body);
    font-size: var(--fs-text-14);
    line-height: var(--fs-leading-body);
  }
  .fg-machine { font-family: var(--fs-font-mono); font-size: var(--fs-text-12); }
  header { max-width: 1400px; margin: 0 auto var(--fs-space-8); }
  h1 { font-size: 26px; font-weight: 600; margin: 0 0 var(--fs-space-2); letter-spacing: 0; }
  .lede { color: var(--fs-ink-2); margin: 0 0 var(--fs-space-4); max-width: 62ch; }
  .flags { display: flex; flex-wrap: wrap; gap: var(--fs-space-2); }
  .flag { border: 1px solid var(--fs-line); border-radius: var(--fs-radius-pill);
          padding: 2px var(--fs-space-3); color: var(--fs-ink-3); }
  section { max-width: 1400px; margin: 0 auto 3rem; }
  h2 { font-size: var(--fs-text-18); font-weight: 600; margin: 0 0 var(--fs-space-5);
       padding-bottom: var(--fs-space-3); border-bottom: 1px solid var(--fs-line);
       display: flex; align-items: baseline; gap: var(--fs-space-3); }
  .count { color: var(--fs-ink-3); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: var(--fs-space-6); }
  .shot { margin: 0; border: 1px solid var(--fs-line);
          border-radius: var(--fs-radius-md); overflow: hidden; background: var(--fs-surface); }
  figcaption { display: flex; align-items: baseline; gap: var(--fs-space-3);
               padding: var(--fs-space-3) var(--fs-space-4);
               border-bottom: 1px solid var(--fs-line); }
  .idx { color: var(--fs-ink-3); }
  .title { font-weight: 500; }
  .meta { margin-left: auto; color: var(--fs-ink-3); }
  img { display: block; width: 100%; height: auto; background: var(--fs-bg); }
  a:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: 2px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <header>
    <h1>Forge Workspace — visual review</h1>
    <p class="lede">
      ${shots.length} real captures of the running prototype, dark and light, desktop and mobile.
      The first two sections show Eenvoudig, the mode a beginner opens in; Uitgebreid has its own
      sections. Every screen is rendered from local example data with the gateway stubbed.
    </p>
    <div class="flags">
      <span class="flag fg-machine">CONNECTED_TO_FORGE=false</span>
      <span class="flag fg-machine">CONNECTED_TO_CLAUDE_CODE=false</span>
      <span class="flag fg-machine">USES_ANTHROPIC_API=false</span>
      <span class="flag fg-machine">REQUIRES_ANTHROPIC_API_KEY=false</span>
      <span class="flag fg-machine">USES_MOCK_DATA=true</span>
      <span class="flag fg-machine">captured ${stamp}</span>
    </div>
  </header>
  ${sections}
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
process.stdout.write(
  `build-gallery: wrote ${path.relative(ROOT, OUT)} - ${shots.length} screenshots\n`,
);
