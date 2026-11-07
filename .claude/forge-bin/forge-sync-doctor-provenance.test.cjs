#!/usr/bin/env node
'use strict';
// forge-sync-doctor-provenance.test.cjs — WP A11 part 2 (Lead integration, Review Boss HIGH on the doctor split).
//
// doctorProvenance() is the "who wrote the gate" check of forge-sync: only a byte-identical TEMPLATE doctor may
// approve an install into a project. After the split the check logic lives in forge-bin/doctor/*.cjs, so the hash
// must cover the root AND every module. These cases pin that: an edited or missing module is `project-local`,
// never `template`. RED on the pre-split-era function (root-only hash): case 2 and case 3 pass as `template` there.
//
// Set FORGE_SYNC_MODULE_UNDER_TEST to an alternative forge-sync.cjs path to run the same cases against another copy
// (used once by the Lead to prove the RED state on the old function).
const fs = require('fs');
const os = require('os');
const path = require('path');

const modulePath = process.env.FORGE_SYNC_MODULE_UNDER_TEST || path.join(__dirname, 'forge-sync.cjs');
const sync = require(modulePath);

let passed = 0, failed = 0;
function t(name, ok, extra) {
  if (ok) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-provenance-'));
function tree(name) {
  const root = path.join(tmp, name);
  const bin = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(path.join(bin, 'doctor'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'forge-doctor.cjs'), "'use strict';\nmodule.exports = { root: true };\n");
  fs.writeFileSync(path.join(bin, 'doctor', 'checks-core.cjs'), "'use strict';\nmodule.exports = { runTests: () => ({ ok: false }) };\n");
  fs.writeFileSync(path.join(bin, 'doctor', 'report.cjs'), "'use strict';\nmodule.exports = { render: () => 'x' };\n");
  return { root, bin, claude: path.join(root, '.claude') };
}

try {
  // The template side is the `.claude` folder of a template tree (forge-sync passes templateDir = <template>/.claude-like dir
  // that contains forge-bin/); here we build it the same way and hand its `.claude` dir as templateDir.
  const template = tree('template');
  const project = tree('project');

  // 1) byte-identical root + modules -> template
  const same = sync.doctorProvenance(project.root, template.claude);
  t('1) identical doctor tree -> kind template', same.kind === 'template', JSON.stringify(same));
  t('1b) the template verdict names the module count', same.modules === 2, JSON.stringify(same));

  // 2) one edited MODULE (root untouched) -> project-local (RED on a root-only hash)
  fs.writeFileSync(path.join(project.bin, 'doctor', 'checks-core.cjs'), "'use strict';\nmodule.exports = { runTests: () => ({ ok: true }) };\n");
  const edited = sync.doctorProvenance(project.root, template.claude);
  t('2) an edited doctor/*.cjs module makes the doctor project-local', edited.kind === 'project-local', JSON.stringify(edited));

  // 3) a module missing on the project side -> project-local with a reason naming it (RED on a root-only hash)
  fs.copyFileSync(path.join(template.bin, 'doctor', 'checks-core.cjs'), path.join(project.bin, 'doctor', 'checks-core.cjs'));
  fs.unlinkSync(path.join(project.bin, 'doctor', 'report.cjs'));
  const missing = sync.doctorProvenance(project.root, template.claude);
  t('3) a module missing on the project side is project-local', missing.kind === 'project-local', JSON.stringify(missing));
  t('3b) the reason names the missing module', /report\.cjs/.test(String(missing.reason)), String(missing.reason));

  // 4) an EXTRA module on the project side -> project-local too
  fs.copyFileSync(path.join(template.bin, 'doctor', 'report.cjs'), path.join(project.bin, 'doctor', 'report.cjs'));
  fs.writeFileSync(path.join(project.bin, 'doctor', 'checks-extra.cjs'), "'use strict';\nmodule.exports = {};\n");
  const extra = sync.doctorProvenance(project.root, template.claude);
  t('4) an extra module on the project side is project-local', extra.kind === 'project-local', JSON.stringify(extra));
  fs.unlinkSync(path.join(project.bin, 'doctor', 'checks-extra.cjs'));

  // 5) edited ROOT -> project-local (the pre-split behaviour still holds)
  fs.writeFileSync(path.join(project.bin, 'forge-doctor.cjs'), "'use strict';\nmodule.exports = { root: 'changed' };\n");
  const rootEdited = sync.doctorProvenance(project.root, template.claude);
  t('5) an edited forge-doctor.cjs is project-local', rootEdited.kind === 'project-local', JSON.stringify(rootEdited));

  // 6) absent doctor / no template -> absent / unknown, unchanged
  fs.unlinkSync(path.join(project.bin, 'forge-doctor.cjs'));
  t('6) no doctor in the project -> absent', sync.doctorProvenance(project.root, template.claude).kind === 'absent');
  t('6b) no template dir -> unknown', sync.doctorProvenance(template.root, null).kind === 'unknown');

  // 7) EOL-insensitive like before: CRLF vs LF module bodies still hash equal
  const p2 = tree('project-crlf');
  fs.writeFileSync(path.join(p2.bin, 'doctor', 'report.cjs'), "'use strict';\r\nmodule.exports = { render: () => 'x' };\r\n");
  t('7) CRLF-only differences in a module do not make it project-local', sync.doctorProvenance(p2.root, template.claude).kind === 'template');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
