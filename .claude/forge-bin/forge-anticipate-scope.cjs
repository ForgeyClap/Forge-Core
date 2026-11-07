#!/usr/bin/env node
'use strict';
/**
 * forge-anticipate-scope.cjs — run scope for forge-anticipate's deliverable types (category tests A2).
 * A META mission (test, evaluate or install Forge into OTHER project folders, each with its own Forge install and its
 * own runs) ships only Forge tooling in THIS run. forge-anticipate declared the projects' craft types (web-ui,
 * copy-and-content, voice-and-chat, game-and-interactive) for the Lead's own tooling run, so the run contract asked that
 * run for craft reviews and web screenshots it could never produce.
 *
 * scopeOf(text, opts) -> {scope:'meta'|'project', source:'--scope'|'text'|'default', why}
 *   - structural first: opts.scope ('meta' or 'project', from `--scope`) always wins; 'project' turns detection off.
 *   - safe default otherwise: meta ONLY when the text names BOTH (a) deliverables in separate/other folders or projects
 *     and (b) installing / testing / monitoring Forge itself. One signal alone stays 'project', so a real website,
 *     app or game request keeps its types (a leading "/forge" command word is not a mention of Forge).
 * metaTypes(opts, lensTypes, wouldBe) -> {types, from}: the explicit --type when it names a lens, else 'code' (Forge's
 *   own code; pass --type cli-and-devtools when the run ships a new user-facing command), with the reason and the
 *   project types that were deliberately NOT declared for this run.
 * Zero-dependency, never throws on bad input.
 */
const SCOPES = ['meta', 'project'];
const META_DEFAULT_TYPE = 'code';
const MAX_TEXT = 20000;
// (a) the deliverables live in other folders / projects
const SEPARATE = [
  /\b(aparte|eigen|losse|nieuwe)\s+(map|mappen|folder|folders|projectmap|projectmappen|directory)\b/,
  /\b(separate|its own|their own|own|new)\s+(folder|folders|directory|directories|project folder|project folders|repo|repos|repository)\b/,
  /\b(in|into|naar)\s+(other|separate|another|andere)\s+(projects?|folders?|repos?|projecten|mappen)\b/,
];
// (b) the mission is about Forge itself (install it, test it, watch it)
const ABOUT_FORGE = [
  /\b(installeer|installeren|install|installs|installing|installed)\b[^.!?\n]{0,80}\bforge\b/,
  /\bforge\b[^.!?\n]{0,40}\b(install|installs|installatie|installeren|install(?:ed|ing))\b/,
  /\b(test|tests|testen|evaluate|evaluates|evalueer|evalueren|monitor|monitors|monitoor|monitort|monitoren)\b[^.!?\n]{0,80}\bforge\b/,
];

const norm = (t) => String(t == null ? '' : t).slice(0, MAX_TEXT).toLowerCase().replace(/(^|\s)\/forge\b/g, '$1');
const firstHit = (res, t) => { for (const re of res) { const m = re.exec(t); if (m) return m[0].trim().slice(0, 80); } return null; };

function scopeOf(text, opts) {
  const forced = opts && opts.scope != null ? String(opts.scope).trim().toLowerCase() : '';
  if (forced) {
    if (!SCOPES.includes(forced)) return { scope: 'project', source: 'default', why: 'unknown --scope ' + JSON.stringify(forced.slice(0, 40)) + ' ignored (meta or project)' };
    return { scope: forced, source: '--scope', why: '--scope ' + forced };
  }
  const t = norm(text), sep = firstHit(SEPARATE, t), about = firstHit(ABOUT_FORGE, t);
  if (sep && about) return { scope: 'meta', source: 'text', why: 'the request names separate project folders ("' + sep + '") and Forge itself ("' + about + '")' };
  return { scope: 'project', source: 'default', why: 'no meta signal pair (separate folders: ' + (sep ? 'yes' : 'no') + ', about Forge: ' + (about ? 'yes' : 'no') + ')' };
}

function metaTypes(opts, lensTypes, wouldBe, scope) {
  const known = Array.isArray(lensTypes) ? lensTypes : [];
  const asked = opts && opts.type ? String(opts.type).toLowerCase().trim().replace(/\s+/g, '-') : '';
  const type = asked && known.includes(asked) ? asked : META_DEFAULT_TYPE;
  const skipped = (Array.isArray(wouldBe) ? wouldBe : []).filter((x) => x && x !== type);
  const why = 'meta mission (' + (scope && scope.why ? scope.why : 'scope meta') + '): the project deliverables are built in their own folders and runs, this run ships Forge tooling'
    + (type === asked ? ' (--type ' + type + ')' : ' (code; pass --type cli-and-devtools when the run ships a new user-facing command)')
    + (skipped.length ? '; not declared for this run: ' + skipped.join(', ') : '');
  return { types: [type], from: [{ type, from: why }] };
}

module.exports = { scopeOf, metaTypes, SCOPES, META_DEFAULT_TYPE };
