#!/usr/bin/env node
'use strict';
/**
 * forge-wpsize.cjs — Head Chef's work-package size classifier. Zero-dependency, read-only,
 * advisory (never a gate). Three factors are scored on the tiers small < standard < large and the HIGHEST tier
 * wins (never an average):
 *   files touched      0-2 small · 3-8 standard · 9+ large (duplicates and blank entries count once)
 *   dependency/contract none small · a new dependency or an internal contract standard · a breaking contract large
 *   design ambiguity    none small · some standard · high large
 * Floor: any security change (an explicit flag, or a touched path whose name says auth, login, session, token,
 * secret, password, crypto, permission, oauth, jwt, payment or billing) or any public-API change (an explicit
 * flag, contract `public`, or an OpenAPI/Swagger/GraphQL/proto file) is at least `standard`. The floor only lifts.
 * route_hint maps the tier to a GOAT route (small quick · standard build · large deep) and sends security or
 * public-API work to deep, because the GOAT table routes auth/security to deep whatever the size.
 *
 * classifySize({files, newDependency, contract, ambiguity, security, publicApi}) ->
 *   {tier, floor, route_hint, factors:{files, contract, ambiguity}, security_paths[], public_api_paths[], reasons[]}
 * CLI: node forge-wpsize.cjs (--files a,b | --files-from <list.txt>) [--new-dep] [--contract none|internal|public|breaking]
 *      [--ambiguity none|some|high] [--security] [--public-api] [--json]
 * Exit: 0 = classified · 2 = usage or invalid input.
 */
const fs = require('fs');

const TIERS = ['small', 'standard', 'large'];
const CONTRACTS = { none: 'small', internal: 'standard', public: 'standard', breaking: 'large' };
const AMBIGUITY = { none: 'small', some: 'standard', high: 'large' };
const FILES_STANDARD = 3;
const FILES_LARGE = 9;
const ROUTE = { small: 'quick', standard: 'build', large: 'deep' };
// Whole path segments or name parts only, so "authors.md" and "tokenizer-notes.md" are not security paths.
const SECURITY_PART = /^(auth|authn|authz|authentication|authorization|login|logout|signin|signup|session|sessions|token|tokens|secret|secrets|password|passwords|crypto|cryptography|permission|permissions|acl|oauth|oauth2|jwt|payment|payments|billing)$/;
const PUBLIC_API_FILE = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.(graphql|gql|proto)$/i;
const NON_CODE = /\.(md|txt|png|jpe?g|gif|svg|webp)$/i;

const rank = (t) => TIERS.indexOf(t);
const maxTier = (a, b) => (rank(a) >= rank(b) ? a : b);

function normFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error('files must be a list of paths');
  const seen = new Set();
  for (const f of files) {
    const p = String(f == null ? '' : f).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (p) seen.add(p);
  }
  return [...seen];
}

function isSecurityPath(p) {
  if (NON_CODE.test(p)) return false;
  const parts = p.toLowerCase().split('/').flatMap((seg) => seg.replace(/\.[a-z0-9]+$/, '').split(/[-_.]/));
  return parts.some((x) => SECURITY_PART.test(x));
}

function classifySize(input) {
  const o = input || {};
  const contract = o.contract === undefined ? 'none' : o.contract;
  const ambiguity = o.ambiguity === undefined ? 'none' : o.ambiguity;
  if (!Object.prototype.hasOwnProperty.call(CONTRACTS, contract)) throw new Error('contract must be one of ' + Object.keys(CONTRACTS).join('|') + ', got ' + JSON.stringify(contract));
  if (!Object.prototype.hasOwnProperty.call(AMBIGUITY, ambiguity)) throw new Error('ambiguity must be one of ' + Object.keys(AMBIGUITY).join('|') + ', got ' + JSON.stringify(ambiguity));
  const files = normFiles(o.files);
  const reasons = [];

  const filesTier = files.length >= FILES_LARGE ? 'large' : files.length >= FILES_STANDARD ? 'standard' : 'small';
  reasons.push('files touched: ' + files.length + ' -> ' + filesTier);
  let contractTier = CONTRACTS[contract];
  if (o.newDependency && rank(contractTier) < rank('standard')) contractTier = 'standard';
  reasons.push('dependency/contract: ' + (o.newDependency ? 'new dependency, ' : '') + 'contract ' + contract + ' -> ' + contractTier);
  const ambiguityTier = AMBIGUITY[ambiguity];
  reasons.push('design ambiguity: ' + ambiguity + ' -> ' + ambiguityTier);

  const securityPaths = files.filter(isSecurityPath);
  const publicApiPaths = files.filter((p) => PUBLIC_API_FILE.test(p));
  const security = !!o.security || securityPaths.length > 0;
  const publicApi = !!o.publicApi || contract === 'public' || contract === 'breaking' || publicApiPaths.length > 0;
  const floor = security || publicApi ? 'standard' : null;
  if (security) reasons.push('security change' + (securityPaths.length ? ' (' + securityPaths.slice(0, 3).join(', ') + ')' : ' (flag)') + ': at least standard');
  if (publicApi) reasons.push('public-API change: at least standard');

  let tier = [filesTier, contractTier, ambiguityTier].reduce(maxTier);
  if (floor) tier = maxTier(tier, floor);
  return {
    tier, floor, route_hint: security || publicApi ? 'deep' : ROUTE[tier],
    factors: { files: { count: files.length, tier: filesTier }, contract: { value: contract, new_dependency: !!o.newDependency, tier: contractTier }, ambiguity: { value: ambiguity, tier: ambiguityTier } },
    security_paths: securityPaths, public_api_paths: publicApiPaths, reasons,
  };
}

module.exports = { classifySize, isSecurityPath, TIERS, CONTRACTS, AMBIGUITY, FILES_STANDARD, FILES_LARGE };

function parseArgs(argv) {
  const a = { files: undefined, filesFrom: null, newDependency: false, contract: undefined, ambiguity: undefined, security: false, publicApi: false, json: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) a.bad = k + ' needs a value'; return v; };
    if (k === '--files') a.files = String(val() || '').split(',');
    else if (k === '--files-from') a.filesFrom = val();
    else if (k === '--new-dep') a.newDependency = true;
    else if (k === '--contract') a.contract = val();
    else if (k === '--ambiguity') a.ambiguity = val();
    else if (k === '--security') a.security = true;
    else if (k === '--public-api') a.publicApi = true;
    else if (k === '--json') a.json = true;
    else a.bad = 'unknown argument ' + k;
  }
  return a;
}

function main(argv) {
  const a = parseArgs(argv);
  const usage = 'Usage: node forge-wpsize.cjs (--files a,b | --files-from <list.txt>) [--new-dep] [--contract none|internal|public|breaking] [--ambiguity none|some|high] [--security] [--public-api] [--json]';
  if (a.bad || (a.files === undefined && !a.filesFrom)) { process.stderr.write((a.bad ? 'forge-wpsize: ' + a.bad + '\n' : '') + usage + '\n'); return 2; }
  let files = a.files || [];
  if (a.filesFrom) {
    try { files = files.concat(fs.readFileSync(a.filesFrom, 'utf8').split(/\r?\n/)); }
    catch (e) { process.stderr.write('forge-wpsize: cannot read ' + a.filesFrom + ' (' + (e.code || e.message) + ')\n'); return 2; }
  }
  let r;
  try { r = classifySize({ files, newDependency: a.newDependency, contract: a.contract, ambiguity: a.ambiguity, security: a.security, publicApi: a.publicApi }); }
  catch (e) { process.stderr.write('forge-wpsize: ' + e.message + '\n'); return 2; }
  if (a.json) process.stdout.write(JSON.stringify(r) + '\n');
  else process.stdout.write('tier: ' + r.tier + (r.floor ? ' (floor ' + r.floor + ')' : '') + ' · route hint: ' + r.route_hint + '\n' + r.reasons.map((x) => '  - ' + x).join('\n') + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('forge-wpsize: internal error: ' + ((e && e.stack) || e) + '\n'); process.exitCode = 2; }
}
