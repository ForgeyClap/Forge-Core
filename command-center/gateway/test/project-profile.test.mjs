// cc-fix-adapter T6d tests — buildProjectProfile() against THIS project's own real
// FORGE_PROJECT_PROFILE.md + FORGE_VERSION.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildProjectProfile } from '../src/project-profile.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { needsFilledProjectProfile } from './.real-data-guard.mjs';

// Real-data assertion: only this repository's own filled-in profile reads "Forge … tooling / meta". A fresh
// clone still carries the installer scaffold and no FORGE_VERSION.json, so it is skipped there with the reason
//the honest-absence test below runs everywhere.
test('buildProjectProfile reads this real project profile + version file', { skip: needsFilledProjectProfile() }, () => {
  const result = buildProjectProfile(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.profile_present, true);
  assert.match(result.project_name, /Forge V2/);
  // The real profile line is free text ("tooling / meta — ... Mixed.") — never forced into a
  // ProjectType bucket, returned verbatim so a consumer can show the real sentence.
  assert.match(result.project_type_raw, /tooling \/ meta/);
  // WP A11 follow-up: the profile refresh of 2026-10-24 (commit 03672b7) dropped the
  // "Project goal" bullet from this repo's real profile, so this assertion failed on every run (alone
  // and in the full suite) — it was never an env leak. The goal is now checked against what the real
  // file says: a goal bullet must come back as non-empty text; no bullet must come back as an honest
  // null that is NOT reported as an unfilled scaffold field.
  const profileText = fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'FORGE_PROJECT_PROFILE.md'), 'utf8');
  if (/^-\s*\*\*Project goal:\*\*/im.test(profileText)) {
    assert.ok(result.project_goal && result.project_goal.length > 0);
  } else {
    assert.equal(result.project_goal, null);
    assert.ok(!result.profile_unfilled_fields.includes('project_goal'));
  }
  assert.equal(result.version_present, true);
  assert.equal(typeof result.forge_version, 'string');
  assert.ok(result.forge_version.length > 0);
});

test('a project with no profile/version files reports honest absence, never a guess', () => {
  const result = buildProjectProfile('/nonexistent/project/path/for-this-test');
  assert.equal(result.ok, true);
  assert.equal(result.profile_present, false);
  assert.equal(result.project_name, null);
  assert.equal(result.project_type_raw, null);
  assert.equal(result.version_present, false);
  assert.equal(result.forge_version, null);
});
