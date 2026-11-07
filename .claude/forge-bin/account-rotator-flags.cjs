#!/usr/bin/env node
'use strict';
/**
 * account-rotator-flags.cjs — the per-slot ORGANIZATION BLOCK of the account rotator (WP SA-ROTATOR-ORGBLOCK, incident
 * `launch --account bussins` started Claude Code, which answered "Your organization has disabled Claude
 * subscription access for Claude Code"). The usage endpoint cannot see such an organization policy, so a slot can look
 * measurable and still be refused by Claude Code. The owner records it once:
 *   mark-blocked <name> --reason "<text>"   -> state.slotFlags[name].orgBlocked = {at, reason}
 *   unblock <name>                          -> removes only orgBlocked (other flags stay)
 * STATE ONLY: the slot file (setup token / login) is never read for its secrets, never written, never printed.
 * An orgBlocked slot is excluded from eligibility (file mode), recommendation and `launch --auto`; `launch --account`
 * refuses it unless --force.
 * launch inherits the child's stdio (Claude Code needs the real terminal), so the rotator CANNOT read the child's
 * output: after an early failed exit it prints the mark-blocked hint (earlyExitHint) and never sets the flag by guessing.
 */
const vault = require('./account-rotator-vault.cjs');

const ORG_BLOCK_LABEL = 'GEBLOKKEERD DOOR ORGANISATIE / BLOCKED BY ORGANIZATION';
const UNTESTED_LABEL = 'niet getest / untested';
const REASON_MAX = 300;
const EARLY_EXIT_MS = 60 * 1000; // a session that fails within a minute most likely failed at start-up

const orgBlockOf = (flags, name) => (flags && name && flags[name] && flags[name].orgBlocked && typeof flags[name].orgBlocked === 'object' ? flags[name].orgBlocked : null);
const isOrgBlocked = (flags, name) => !!orgBlockOf(flags, name);
/** cleanReason(text) -> a single-line, bounded, scrubbed reason, or null when empty. */
function cleanReason(text) {
  if (typeof text !== 'string') return null;
  const s = vault.scrub(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, REASON_MAX);
  return s || null;
}
function orgBlockText(flag) { return ORG_BLOCK_LABEL + (flag ? ' (' + (flag.reason || '?') + ', ' + (flag.at || '?') + ')' : ''); }
function launchRefusal(name, flag) {
  return '"' + name + '" is ' + orgBlockText(flag) + ' — de organisatie van dit account staat Claude Code met een abonnement niet toe; kies een ander account, of `unblock ' + name + '` als dat is opgelost, of eenmalig toch: --force'
    + ' / the organization of this account does not allow Claude Code on a subscription; pick another account, or `unblock ' + name + '` once that is resolved, or once anyway: --force';
}
/** earlyExitHint(name, code, ms) -> a hint line, or null. The rotator cannot read the child's output (inherited stdio). */
function earlyExitHint(name, code, ms) {
  if (!name || code === 0 || !(ms < EARLY_EXIT_MS)) return null;
  return 'Claude Code stopte meteen (exit ' + code + '). Meldde het "Your organization has disabled Claude subscription access"? Leg dat vast: node .claude/forge-bin/account-rotator.cjs mark-blocked ' + name + ' --reason "<melding>"'
    + ' / Claude Code exited right away (exit ' + code + '). If it said "Your organization has disabled Claude subscription access", record it: node .claude/forge-bin/account-rotator.cjs mark-blocked ' + name + ' --reason "<message>"';
}
function valueOf(args, flag) { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; }

async function cmdMarkBlocked(P, args, deps, h) {
  const name = h.positional(args)[0];
  if (!vault.validName(name) || !vault.readSlot(P, name)) { deps.err('onbekend account / unknown account: ' + (name || '(geen / none)') + ' — gebruik / usage: mark-blocked <naam/name> --reason "<tekst/text>"'); return 2; }
  const reason = cleanReason(valueOf(args, '--reason'));
  if (!reason) { deps.err('gebruik / usage: mark-blocked ' + name + ' --reason "<tekst/text>" — een reden is verplicht / a reason is required'); return 2; }
  const at = new Date(deps.now()).toISOString();
  const saved = await vault.updateState(P, (s) => { s.slotFlags[name] = Object.assign({}, s.slotFlags[name] || {}, { orgBlocked: { at, reason } }); });
  if (!saved) { deps.err('state.json is bezet / is locked — probeer opnieuw / try again'); return 1; }
  vault.log(P, 'mark-blocked ' + name + ' — ' + reason, { quiet: true });
  deps.out(name + ': ' + orgBlockText({ at, reason }) + ' — niet meer gekozen door aanbeveling of launch --auto; launch --account weigert zonder --force / no longer chosen by recommendation or launch --auto; launch --account refuses without --force. Opheffen / lift: unblock ' + name);
  return 0;
}
async function cmdUnblock(P, args, deps, h) {
  const name = h.positional(args)[0];
  if (!vault.validName(name) || !vault.readSlot(P, name)) { deps.err('onbekend account / unknown account: ' + (name || '(geen / none)') + ' — gebruik / usage: unblock <naam/name>'); return 2; }
  let had = false;
  const saved = await vault.updateState(P, (s) => {
    const f = s.slotFlags[name];
    if (!f || !f.orgBlocked) return;
    had = true;
    const rest = Object.assign({}, f); delete rest.orgBlocked;
    if (Object.keys(rest).length) s.slotFlags[name] = rest; else delete s.slotFlags[name];
  });
  if (!saved) { deps.err('state.json is bezet / is locked — probeer opnieuw / try again'); return 1; }
  if (had) vault.log(P, 'unblock ' + name, { quiet: true });
  deps.out(had ? name + ': blokkade opgeheven / block lifted' : name + ': was niet geblokkeerd / was not blocked');
  return 0;
}

module.exports = { ORG_BLOCK_LABEL, UNTESTED_LABEL, EARLY_EXIT_MS, orgBlockOf, isOrgBlocked, cleanReason, orgBlockText, launchRefusal, earlyExitHint, cmdMarkBlocked, cmdUnblock };
