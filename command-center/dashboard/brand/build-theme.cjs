#!/usr/bin/env node
/**
 * build-theme.cjs - turns brand/tokens.json into brand/forge-tokens.css
 *
 * Zero dependencies. Node 18+.
 *
 *   node brand/build-theme.cjs            write forge-tokens.css
 *   node brand/build-theme.cjs --check    exit 1 if the CSS has drifted from tokens.json
 *   node brand/build-theme.cjs --inline   print a <style> block on stdout (self-contained HTML)
 *
 * Brand v1.0. Output order:
 *   :root                                  theme-independent --fs-* tokens
 *   :root, [data-theme="light"]            light (the default)
 *   [data-theme="dark"]                    dark
 *   @media (prefers-color-scheme: dark)    dark when no data-theme is set ("Zoals Windows")
 *   @media (prefers-reduced-motion)        every duration to 0
 *
 * The alias bridge (old --forge-* and v0.1 --fs-* names) was deleted in redesign: every view reads
 * the v1.0 --fs-* names directly. The build fails when tokens.json still carries a "bridge" block.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const TOKENS_PATH = path.join(DIR, 'tokens.json');
const CSS_PATH = path.join(DIR, 'forge-tokens.css');

function fail(msg) {
  process.stderr.write(`build-theme: ${msg}\n`);
  process.exit(1);
}

/** [name, value] pairs of a flat token object, skipping `_comment`-style keys. */
function entries(obj, where) {
  if (!obj || typeof obj !== 'object') fail(`tokens.json is missing ${where}`);
  return Object.entries(obj).filter(([key]) => !key.startsWith('_') && !key.startsWith('$')).map(([key, value]) => {
    if (typeof value !== 'string') fail(`${where}.${key} must be a string`);
    if (!/^[a-z][a-z0-9-]*$/.test(key)) fail(`${where}.${key} is not a valid custom property name`);
    return [key, value];
  });
}

function rules(selector, pairs, indent = '', lead = []) {
  const inner = `${indent}  `;
  const lines = lead.map((l) => `${inner}${l}`).concat(pairs.map(([n, v]) => `${inner}--${n}: ${v};`));
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}`;
}

function build() {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot read tokens.json - ${err.message}`);
  }
  const meta = source.$meta || {};
  const fsTokens = source.fs || {};
  if (source.bridge !== undefined) fail('tokens.json has a "bridge" block; the alias bridge was removed in wave 4, use --fs-* names');

  const globals = entries(fsTokens.global, 'fs.global');
  const light = entries(fsTokens.light, 'fs.light');
  const dark = entries(fsTokens.dark, 'fs.dark');
  const reduced = entries(fsTokens['reduced-motion'], 'fs.reduced-motion');

  // Both themes must define exactly the same names.
  const lightNames = light.map(([n]) => n).join(',');
  const darkNames = dark.map(([n]) => n).join(',');
  if (lightNames !== darkNames) fail('fs.light and fs.dark must list the same tokens in the same order');

  const body = [
    rules(':root', globals),
    '',
    '/* Light is the default. Dark is a deep green-slate, never black. */',
    rules(':root, [data-theme="light"]', light, '', ['color-scheme: light;']),
    '',
    rules('[data-theme="dark"]', dark, '', ['color-scheme: dark;']),
    '',
    '/* "Zoals Windows" before the first-paint script has run (or without it). */',
    '@media (prefers-color-scheme: dark) {',
    rules(':root:not([data-theme])', dark, '  ', ['color-scheme: dark;']),
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    rules(':root', reduced, '  '),
    '}',
  ].join('\n');

  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const header = [
    '/*',
    ` * ${meta.name || 'Forge'} design tokens - GENERATED FILE, DO NOT EDIT.`,
    ' * Source: brand/tokens.json   Rebuild: node brand/build-theme.cjs',
    ` * Content hash: ${digest}`,
    ' */',
    '',
  ].join('\n');

  return { css: header + body + '\n', digest };
}

const args = new Set(process.argv.slice(2));
const { css, digest } = build();

if (args.has('--inline')) {
  process.stdout.write(`<style>\n${css}</style>\n`);
  process.exit(0);
}

if (args.has('--check')) {
  let onDisk = '';
  try {
    onDisk = fs.readFileSync(CSS_PATH, 'utf8');
  } catch {
    process.stderr.write('build-theme: forge-tokens.css is missing. Run: node brand/build-theme.cjs\n');
    process.exit(1);
  }
  // Line endings are not drift: a Windows checkout (core.autocrlf) stores CRLF.
  if (onDisk.replace(/\r\n/g, '\n') !== css) {
    process.stderr.write(
      'build-theme: forge-tokens.css has drifted from tokens.json.\n' +
        '             Someone edited the generated CSS by hand, or forgot to rebuild.\n' +
        '             Fix with: node brand/build-theme.cjs\n'
    );
    process.exit(1);
  }
  process.stdout.write(`build-theme: tokens in sync (${digest})\n`);
  process.exit(0);
}

fs.writeFileSync(CSS_PATH, css, 'utf8');
const count = (css.match(/^\s+--/gm) || []).length;
process.stdout.write(`build-theme: wrote forge-tokens.css - ${count} declarations (${digest})\n`);
