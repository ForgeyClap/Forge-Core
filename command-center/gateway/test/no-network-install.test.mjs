// WP-NONET regression: a test run must NEVER run a real `npm ci`/`npm install`.
// Found by a public-tree verify run: with no command-center/discord/node_modules present,
// discord-service-real-spawn.test.mjs fell through startDiscordService() ->
// ensureDiscordDepsInstalled() to a REAL npm install against the network (~3,100 files).
//
// These tests put a logging npm shim first on PATH (it writes a marker file and exits 1) and
// call the real install path WITHOUT an injected runner. If the production guard ever regresses,
// the shim is invoked, the marker appears and the test fails — no real npm is ever reached
// because the shim shadows it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDiscordDepsInstalled,
  _setDiscordPathsForTests,
  _resetDiscordServiceForTests,
  _resetDiscordDepsInstallStateForTests,
} from '../src/discord-service.mjs';

let tempDir;
let shimDir;
let markerFile;
let savedPath;
let savedForgeTest;
let savedNodeTestContext;

function writeNpmShims(dir, marker) {
  for (const name of ['npm', 'npx']) {
    fs.writeFileSync(
      path.join(dir, name + '.cmd'),
      `@echo off\r\necho ${name} %*>>"${marker}"\r\nexit /b 1\r\n`,
      'utf8',
    );
    const posix = path.join(dir, name);
    fs.writeFileSync(posix, `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 1\n`, 'utf8');
    fs.chmodSync(posix, 0o755);
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-no-network-install-'));
  shimDir = path.join(tempDir, 'shim');
  fs.mkdirSync(shimDir);
  markerFile = path.join(tempDir, 'npm-shim-called.log');
  writeNpmShims(shimDir, markerFile);

  const discordDir = path.join(tempDir, 'discord');
  fs.mkdirSync(discordDir);
  fs.writeFileSync(path.join(discordDir, 'package.json'), '{"name":"x","dependencies":{"discord.js":"^14.0.0"}}\n', 'utf8');
  fs.writeFileSync(path.join(discordDir, 'package-lock.json'), '{}\n', 'utf8');
  _setDiscordPathsForTests({
    discordDir,
    mainJs: path.join(discordDir, 'src', 'main.js'),
    envFile: path.join(discordDir, '.env'),
    envExampleFile: path.join(discordDir, '.env.example'),
    stateDir: path.join(tempDir, 'state'),
    logFile: path.join(tempDir, 'discord-bot.log'),
  });

  savedPath = process.env.PATH;
  savedForgeTest = process.env.FORGE_TEST;
  savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.PATH = shimDir + path.delimiter + savedPath;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedForgeTest === undefined) delete process.env.FORGE_TEST;
  else process.env.FORGE_TEST = savedForgeTest;
  if (savedNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
  _resetDiscordDepsInstallStateForTests();
  _resetDiscordServiceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function assertNoInstallHappened() {
  assert.equal(fs.existsSync(markerFile), false, 'npm shim was invoked: ' + (fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : ''));
  assert.equal(fs.existsSync(path.join(tempDir, 'discord', 'node_modules')), false, 'node_modules must not be created');
}

test('under node --test (NODE_TEST_CONTEXT) a missing-deps install is refused — npm is never spawned', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test should set NODE_TEST_CONTEXT in this process');
  const result = await ensureDiscordDepsInstalled();
  assert.equal(result.ok, false);
  assert.match(result.message, /disabled during a test run/);
  assertNoInstallHappened();
});

test('FORGE_TEST=1 alone also refuses the real install (harnesses other than node --test)', async () => {
  delete process.env.NODE_TEST_CONTEXT;
  process.env.FORGE_TEST = '1';
  const result = await ensureDiscordDepsInstalled();
  assert.equal(result.ok, false);
  assert.match(result.message, /disabled during a test run/);
  assertNoInstallHappened();
});
