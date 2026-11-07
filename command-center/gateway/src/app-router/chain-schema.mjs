// App router — config defaults, validation and the effective chain (design sections 2.2-2.5).
// Pure: no file access except the read-only provider registry: the merged registry (bundled catalogue plus
// the user's own "Eigen API" entries, ANY-MODEL-PLAN), cached by custom-registry.mjs.
//
// Q5-EIGEN-API: a router entry that names a well-formed custom-* id the merged registry no longer holds (the
// Eigen API was deleted, turned off or refused), or whose Eigen API now needs a key while the entry never
// confirmed the cost (paid_ack), can be judged as a WARNING instead of an error (option allowUnavailable), so
// the user's stored chain keeps working; the turn router then skips that entry (unusableCustomEntryReason).
import { redact } from '../redact.mjs';
import { loadMergedRegistry } from '../providers/custom-registry.mjs';
import { isCustomId } from '../providers/custom-rules.mjs';
import {
  ROUTER_VERSION, MODES, ENTRY_KINDS, STRATEGIES, RETURN_POLICIES, LIMITS,
  ID_RE, MODEL_RE, WINDOWS_DEVICE_NAMES, MAIN_ID,
} from './contract.mjs';

const TOP_KEYS = new Set(['version', 'revision', 'mode', 'multi_account', 'defaults', 'entries', 'updated_at']);
const MULTI_KEYS = new Set(['enabled', 'acknowledged_at']);
const DEFAULT_KEYS = new Set(['threshold_pct', 'cooldown_min', 'strategy', 'return', 'handover_turns']);
const ENTRY_KEYS = Object.freeze({
  'claude-account': new Set(['id', 'kind', 'label', 'profile', 'enabled', 'threshold_pct']),
  'codex-account': new Set(['id', 'kind', 'label', 'profile', 'enabled', 'threshold_pct']),
  'provider-model': new Set(['id', 'kind', 'label', 'provider', 'model', 'enabled', 'threshold_pct', 'num_ctx', 'vars', 'paid_ack', 'notice_ack']),
});
const RESERVED = new Set(WINDOWS_DEVICE_NAMES);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Control characters (C0, DEL, C1). Written as escapes so this file stays plain text.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Auth types that need no key from the user (design 2.4: "needs an API key" -> paid_ack).
const NO_KEY_AUTH = new Set(['none', 'bearer-optional', 'cli-managed']);

/** Messages per error code. Dutch first; no app jargon (see the dashboard's i18n jargon test). */
const MESSAGES = Object.freeze({
  bad_shape: ['De instellingen hebben niet de juiste vorm.', 'The settings do not have the right shape.'],
  bad_version: ['Onbekende versie van de router-instellingen.', 'Unknown version of the router settings.'],
  bad_revision: ['Het versienummer van de instellingen klopt niet.', 'The settings revision number is not valid.'],
  bad_mode: ['Kies een van de vier standen.', 'Choose one of the four settings.'],
  unknown_key: ['Dit veld is onbekend en wordt niet bewaard.', 'This field is unknown and is not saved.'],
  bad_kind: ['Onbekende soort onderdeel.', 'Unknown kind of entry.'],
  bad_type: ['Deze waarde heeft het verkeerde type.', 'This value has the wrong type.'],
  bad_id: ['De naam-code mag alleen kleine letters, cijfers en streepjes hebben (max. 32).', 'The id may only use lower-case letters, digits and dashes (max. 32).'],
  duplicate_id: ['Deze naam-code bestaat al.', 'This id already exists.'],
  reserved_id: ['Deze naam-code is gereserveerd.', 'This id is reserved.'],
  bad_label: ['Geef een naam van 1 tot 40 tekens, zonder speciale stuurtekens.', 'Give a name of 1 to 40 characters, without control characters.'],
  secret_like_value: ['Dit lijkt op een geheime sleutel. Die bewaart Forge nooit in de router.', 'This looks like a secret key. Forge never stores one in the router.'],
  main_missing: ['Je gewone Claude-login (Hoofdaccount) ontbreekt.', 'Your normal Claude login (main account) is missing.'],
  main_duplicate: ['Er mag maar een gewone Claude-login in de lijst staan.', 'There can be only one normal Claude login in the list.'],
  bad_profile: ['De mapnaam van dit account is niet geldig.', 'The folder name of this account is not valid.'],
  duplicate_profile: ['Twee accounts gebruiken dezelfde map.', 'Two accounts use the same folder.'],
  too_many_entries: ['Maximaal 12 onderdelen in de router.', 'At most 12 entries in the router.'],
  too_many_claude: ['Maximaal 8 Claude-accounts.', 'At most 8 Claude accounts.'],
  too_many_codex: ['Maximaal 1 Codex-account.', 'At most 1 Codex account.'],
  out_of_range: ['Deze waarde valt buiten het toegestane bereik.', 'This value is outside the allowed range.'],
  bad_enum: ['Kies een van de aangeboden keuzes.', 'Choose one of the offered options.'],
  unknown_provider: ['Deze aanbieder is onbekend of kan hier niet gebruikt worden.', 'This provider is unknown or cannot be used here.'],
  bad_model: ['De modelnaam is niet geldig.', 'The model name is not valid.'],
  bad_vars: ['Een extra instelling van deze aanbieder is niet geldig.', 'An extra setting of this provider is not valid.'],
  paid_ack_required: ['Bevestig dat dit model per gebruik kost via je eigen sleutel.', 'Confirm that this model costs per use through your own key.'],
  notice_ack_required: ['Bevestig dat je berichten dan naar deze online dienst gaan.', 'Confirm that your messages then go to this online service.'],
  multi_account_required: ['Zet eerst wisselen tussen eigen accounts aan en bevestig de waarschuwing.', 'First turn on switching between your own accounts and confirm the warning.'],
  needs_two_accounts: ['Voor deze stand heb je minstens 2 ingeschakelde Claude-accounts nodig.', 'This setting needs at least 2 enabled Claude accounts.'],
  fallback_missing: ['Kies een Claude-account en een eigen model om op terug te vallen.', 'Choose a Claude account and your own model to fall back to.'],
  model_first_order: ['Bij "Meteen eigen model" moet je eigen model bovenaan staan.', 'With "Your own model right away" your own model must be first.'],
  ack_missing: ['Bevestig eerst dat alle accounts van jou zijn.', 'First confirm that every account is yours.'],
});

/** Warning texts (not errors: the config stays usable). Dutch first; no app jargon. */
const WARNINGS = Object.freeze({
  provider_unavailable: [
    'Deze eigen API is weg, staat uit of kan niet gebruikt worden. Forge slaat dit onderdeel over tot je hem weer aanzet of het onderdeel weghaalt.',
    'This own API was removed, is turned off or cannot be used. Forge skips this entry until you turn it back on or remove the entry.',
  ],
  paid_ack_required: [
    'Deze eigen API vraagt nu een sleutel en kost per gebruik. Forge slaat dit onderdeel over tot je die kosten bevestigt.',
    'This own API now needs a key and costs per use. Forge skips this entry until you confirm that cost.',
  ],
});

/** The user-facing {nl, en} text for an unusable-entry reason (provider_unavailable | paid_ack_required), else null. */
export function unusableEntryText(reason) {
  const t = Object.prototype.hasOwnProperty.call(WARNINGS, reason) ? WARNINGS[reason] : null;
  return t ? { nl: t[0], en: t[1] } : null;
}

function err(path, code) {
  const [nl, en] = MESSAGES[code];
  return { path, code, nl, en };
}
function warn(path, code, entry) {
  const [nl, en] = WARNINGS[code];
  return { path, code, nl, en, entry_id: typeof entry.id === 'string' ? entry.id : null, provider: entry.provider };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;
export function isIsoTimestamp(v) {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}

const NO_REGISTRY = Object.freeze({ get: () => null });

/** The given registry seam, else the merged registry; a broken bundled registry makes every provider unknown. */
export function providerRegistry(registry) {
  if (registry) return registry;
  try {
    return loadMergedRegistry();
  } catch {
    return NO_REGISTRY;
  }
}

/** The registry entry's auth needs a key from the user and the chain entry never confirmed the cost. */
function paidAckMissing(entry, reg) {
  return !!reg && !NO_KEY_AUTH.has(reg.authType) && entry.paid_ack !== true;
}

/**
 * Why a provider-model entry naming a custom-* id must be walked past at turn time, or null when it is usable:
 * 'provider_unavailable' (its Eigen API is gone, turned off or refused) or 'paid_ack_required' (its Eigen API now
 * needs a key and the entry never confirmed the cost, so it must never run and spend). Never throws.
 * @returns {null|'provider_unavailable'|'paid_ack_required'}
 */
export function unusableCustomEntryReason(entry, registry) {
  if (!isObj(entry) || entry.kind !== 'provider-model' || !isCustomId(entry.provider)) return null;
  const reg = providerRegistry(registry).get(entry.provider);
  if (!reg) return 'provider_unavailable';
  return paidAckMissing(entry, reg) ? 'paid_ack_required' : null;
}

/** Map entry id -> reason for every entry of `config` that unusableCustomEntryReason() flags. Never throws. */
export function unusableEntryReasons(config, { registry } = {}) {
  const reg = providerRegistry(registry);
  const reasons = new Map();
  if (!isObj(config) || !Array.isArray(config.entries)) return reasons;
  for (const e of config.entries) {
    const reason = unusableCustomEntryReason(e, reg);
    if (reason && typeof e.id === 'string') reasons.set(e.id, reason);
  }
  return reasons;
}

/** Ids of the entries of `config` that unusableCustomEntryReason() flags (either reason). Never throws. */
export function unavailableEntryIds(config, opts) {
  return new Set(unusableEntryReasons(config, opts).keys());
}

/** A copy of `config` with the entries in `ids` turned off, so selection walks past them like any turned-off entry. */
export function withEntriesOff(config, ids) {
  if (!isObj(config) || !Array.isArray(config.entries) || !ids || ids.size === 0) return config;
  return { ...config, entries: config.entries.map((e) => (isObj(e) && ids.has(e.id) ? { ...e, enabled: false } : e)) };
}

/** A fresh default config: router off, only the user's normal Claude login. */
export function defaultRouterConfig() {
  return {
    version: ROUTER_VERSION,
    revision: 0,
    mode: 'off',
    multi_account: { enabled: false, acknowledged_at: null },
    defaults: {
      threshold_pct: LIMITS.THRESHOLD_DEFAULT,
      cooldown_min: LIMITS.COOLDOWN_DEFAULT,
      strategy: 'in-order',
      return: 'new-conversation',
      handover_turns: LIMITS.HANDOVER_TURNS_DEFAULT,
    },
    entries: [{ id: MAIN_ID, kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null }],
    updated_at: null,
  };
}

function unknownKeys(obj, allowed, base, errors) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) errors.push(err(base ? base + '.' + k : k, 'unknown_key'));
}

/** Every string anywhere in the config that redact() would change is refused (design 2.3). */
function secretScan(value, path, errors) {
  if (typeof value === 'string') {
    if (redact(value) !== value) errors.push(err(path, 'secret_like_value'));
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => secretScan(v, path + '[' + i + ']', errors)); return; }
  if (isObj(value)) for (const [k, v] of Object.entries(value)) secretScan(v, path ? path + '.' + k : k, errors);
}

function validateDefaults(d, errors) {
  if (!isObj(d)) { errors.push(err('defaults', 'bad_shape')); return; }
  unknownKeys(d, DEFAULT_KEYS, 'defaults', errors);
  if (!inRange(d.threshold_pct, LIMITS.THRESHOLD_MIN, LIMITS.THRESHOLD_MAX)) errors.push(err('defaults.threshold_pct', 'out_of_range'));
  if (!inRange(d.cooldown_min, LIMITS.COOLDOWN_MIN, LIMITS.COOLDOWN_MAX)) errors.push(err('defaults.cooldown_min', 'out_of_range'));
  if (!inRange(d.handover_turns, LIMITS.HANDOVER_TURNS_MIN, LIMITS.HANDOVER_TURNS_MAX)) errors.push(err('defaults.handover_turns', 'out_of_range'));
  if (!STRATEGIES.includes(d.strategy)) errors.push(err('defaults.strategy', 'bad_enum'));
  if (!RETURN_POLICIES.includes(d.return)) errors.push(err('defaults.return', 'bad_enum'));
}

function validateMulti(m, errors) {
  if (!isObj(m)) { errors.push(err('multi_account', 'bad_shape')); return; }
  unknownKeys(m, MULTI_KEYS, 'multi_account', errors);
  if (typeof m.enabled !== 'boolean') errors.push(err('multi_account.enabled', 'bad_type'));
  if (m.enabled === true && !isIsoTimestamp(m.acknowledged_at)) errors.push(err('multi_account.acknowledged_at', 'ack_missing'));
  if (m.acknowledged_at !== null && m.acknowledged_at !== undefined && !isIsoTimestamp(m.acknowledged_at) && m.enabled !== true) {
    errors.push(err('multi_account.acknowledged_at', 'bad_type'));
  }
}

function validateProvider(e, p, ctx, errors) {
  const reg = typeof e.provider === 'string' ? ctx.registry.get(e.provider) : null;
  if (!reg && isCustomId(e.provider) && ctx.mayBeUnavailable(e, 'provider_unavailable')) ctx.warnings.push(warn(p + '.provider', 'provider_unavailable', e));
  else if (!reg || typeof reg.adapter !== 'string' || reg.adapter.startsWith('cli-')) errors.push(err(p + '.provider', 'unknown_provider'));
  if (typeof e.model !== 'string' || !MODEL_RE.test(e.model)) errors.push(err(p + '.model', 'bad_model'));
  if (e.num_ctx !== undefined && e.num_ctx !== null && !inRange(e.num_ctx, LIMITS.NUM_CTX_MIN, LIMITS.NUM_CTX_MAX)) errors.push(err(p + '.num_ctx', 'out_of_range'));
  for (const k of ['paid_ack', 'notice_ack']) if (e[k] !== undefined && typeof e[k] !== 'boolean') errors.push(err(p + '.' + k, 'bad_type'));
  if (e.vars !== undefined && e.vars !== null) {
    const specs = (reg && reg.templateVars) || {};
    const ok = isObj(e.vars) && Object.entries(e.vars).every(([k, v]) => Object.prototype.hasOwnProperty.call(specs, k)
      && typeof v === 'string' && new RegExp(specs[k].pattern).test(v));
    if (!ok) errors.push(err(p + '.vars', 'bad_vars'));
  }
  if (!reg) return;
  if (paidAckMissing(e, reg)) {
    // A stored Eigen API entry whose API got a key later: a warning (the turn router skips it), never a broken file.
    if (isCustomId(e.provider) && ctx.mayBeUnavailable(e, 'paid_ack_required')) ctx.warnings.push(warn(p + '.paid_ack', 'paid_ack_required', e));
    else errors.push(err(p + '.paid_ack', 'paid_ack_required'));
  }
  if (reg.noticeRequired === true && reg.local === false && e.notice_ack !== true) errors.push(err(p + '.notice_ack', 'notice_ack_required'));
}

function validateEntry(e, i, ctx, errors) {
  const p = 'entries[' + i + ']';
  if (!isObj(e)) { errors.push(err(p, 'bad_shape')); return; }
  if (!ENTRY_KINDS.includes(e.kind)) { errors.push(err(p + '.kind', 'bad_kind')); return; }
  unknownKeys(e, ENTRY_KEYS[e.kind], p, errors);
  const isMain = e.kind === 'claude-account' && e.profile === null && e.id === MAIN_ID;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) errors.push(err(p + '.id', 'bad_id'));
  else if ((e.id === MAIN_ID && !isMain) || RESERVED.has(e.id)) errors.push(err(p + '.id', 'reserved_id'));
  else if (ctx.ids.has(e.id)) errors.push(err(p + '.id', 'duplicate_id'));
  if (typeof e.id === 'string') ctx.ids.add(e.id);
  if (typeof e.label !== 'string' || e.label.length < 1 || e.label.length > LIMITS.LABEL_MAX || CONTROL_RE.test(e.label)) errors.push(err(p + '.label', 'bad_label'));
  if (typeof e.enabled !== 'boolean') errors.push(err(p + '.enabled', 'bad_type'));
  if (e.threshold_pct !== undefined && e.threshold_pct !== null && !inRange(e.threshold_pct, LIMITS.THRESHOLD_MIN, LIMITS.THRESHOLD_MAX)) errors.push(err(p + '.threshold_pct', 'out_of_range'));

  if (e.kind === 'claude-account') {
    ctx.claude += 1;
    if (e.profile === null) {
      ctx.mainCount += 1;
      if (e.id === MAIN_ID) ctx.mainFound = true;
      if (ctx.mainCount > 1) errors.push(err(p, 'main_duplicate'));
    } else if (!profileSlugValid(e.profile)) {
      errors.push(err(p + '.profile', 'bad_profile'));
    } else if (ctx.profiles.has(e.profile)) {
      errors.push(err(p + '.profile', 'duplicate_profile'));
    } else {
      ctx.profiles.add(e.profile);
    }
  } else if (e.kind === 'codex-account') {
    ctx.codex += 1;
    if (e.profile !== null) errors.push(err(p + '.profile', 'bad_profile'));
  } else {
    validateProvider(e, p, ctx, errors);
  }
}

/** Profile slugs follow the id rule; `main` and the Windows device names are never a folder. */
export function profileSlugValid(slug) {
  return typeof slug === 'string' && ID_RE.test(slug) && slug !== MAIN_ID && !RESERVED.has(slug);
}

function validateModeRules(c, errors) {
  if (!Array.isArray(c.entries) || !MODES.includes(c.mode)) return;
  const on = c.entries.filter((e) => isObj(e) && e.enabled === true);
  const claudeOn = on.filter((e) => e.kind === 'claude-account').length;
  const fallbackOn = on.filter((e) => e.kind === 'provider-model' || e.kind === 'codex-account').length;
  if (c.mode === 'claude-accounts') {
    if (!(isObj(c.multi_account) && c.multi_account.enabled === true)) errors.push(err('mode', 'multi_account_required'));
    if (claudeOn < 2) errors.push(err('mode', 'needs_two_accounts'));
  } else if (c.mode === 'claude-then-model') {
    if (claudeOn < 1 || fallbackOn < 1) errors.push(err('mode', 'fallback_missing'));
  } else if (c.mode === 'model-first') {
    const first = on[0];
    if (!first || (first.kind !== 'provider-model' && first.kind !== 'codex-account')) errors.push(err('mode', 'model_first_order'));
  }
}

function unavailablePolicy(allow) {
  if (allow === true) return () => true;
  if (typeof allow === 'function') return (e, reason) => allow(e, reason) === true;
  return () => false;
}

/**
 * Validates a router config (design 2.4). Never throws.
 * @param {unknown} config
 * @param {{registry?: {get(id:string): object|null},
 *   allowUnavailable?: boolean|((entry: object, reason: 'provider_unavailable'|'paid_ack_required') => boolean)}} [opts]
 *   registry: seam; default the merged registry (bundled + enabled, valid custom-* entries). A broken bundled
 *   registry makes every provider unknown.
 *   allowUnavailable (Q5-EIGEN-API): when given, a provider-model entry naming a well-formed custom-* id that the
 *   registry does not hold (`provider_unavailable`), or whose Eigen API needs a key while the entry has no
 *   paid_ack (`paid_ack_required`), is a warning instead of an error — for every such entry (true) or only where
 *   the predicate (entry, reason) says so. Without it the answer is strict and exactly {ok, errors}.
 * @returns {{ok: boolean, errors: Array<{path:string, code:string, nl:string, en:string}>,
 *   warnings?: Array<{path:string, code:'provider_unavailable'|'paid_ack_required', nl:string, en:string, entry_id:string|null, provider:string}>}}
 *   `warnings` is present only when allowUnavailable is given.
 */
export function validateRouterConfig(config, { registry, allowUnavailable } = {}) {
  const errors = [];
  const warnings = [];
  const lenient = allowUnavailable === true || typeof allowUnavailable === 'function';
  const answer = () => (lenient ? { ok: errors.length === 0, errors, warnings } : { ok: errors.length === 0, errors });
  if (!isObj(config)) {
    errors.push(err('', 'bad_shape'));
    return answer();
  }
  const reg = providerRegistry(registry);
  unknownKeys(config, TOP_KEYS, '', errors);
  if (config.version !== ROUTER_VERSION) errors.push(err('version', 'bad_version'));
  if (!isInt(config.revision) || config.revision < 0) errors.push(err('revision', 'bad_revision'));
  if (!MODES.includes(config.mode)) errors.push(err('mode', 'bad_mode'));
  if (config.updated_at !== undefined && config.updated_at !== null && !isIsoTimestamp(config.updated_at)) errors.push(err('updated_at', 'bad_type'));
  validateMulti(config.multi_account, errors);
  validateDefaults(config.defaults, errors);
  if (!Array.isArray(config.entries)) {
    errors.push(err('entries', 'bad_shape'));
  } else {
    const ctx = {
      ids: new Set(), profiles: new Set(), claude: 0, codex: 0, mainCount: 0, mainFound: false,
      registry: reg, warnings, mayBeUnavailable: unavailablePolicy(allowUnavailable),
    };
    config.entries.forEach((e, i) => validateEntry(e, i, ctx, errors));
    if (!ctx.mainFound) errors.push(err('entries', 'main_missing'));
    if (config.entries.length > LIMITS.MAX_ENTRIES) errors.push(err('entries', 'too_many_entries'));
    if (ctx.claude > LIMITS.MAX_CLAUDE) errors.push(err('entries', 'too_many_claude'));
    if (ctx.codex > LIMITS.MAX_CODEX) errors.push(err('entries', 'too_many_codex'));
  }
  validateModeRules(config, errors);
  secretScan(config, '', errors);
  return answer();
}

/**
 * Every stored entry with whether it is in the effective chain and, if not, why (design 2.5).
 * excluded_reason: null | 'disabled' | 'mode' | 'multi_account_off'. Never throws.
 * @returns {Array<{entry: object, in_chain: boolean, excluded_reason: string|null}>}
 */
export function describeChain(config) {
  if (!isObj(config) || !Array.isArray(config.entries)) return [];
  const multiOn = isObj(config.multi_account) && config.multi_account.enabled === true;
  let claudeSeen = false;
  return config.entries.filter(isObj).map((raw) => {
    const entry = structuredClone(raw);
    let reason = null;
    if (config.mode === 'off' || !MODES.includes(config.mode)) reason = 'mode';
    else if (entry.enabled !== true) reason = 'disabled';
    else if (config.mode === 'claude-accounts' && entry.kind !== 'claude-account') reason = 'mode';
    else if (entry.kind === 'claude-account') {
      if (claudeSeen && !multiOn) reason = 'multi_account_off';
      claudeSeen = true;
    }
    return { entry, in_chain: reason === null, excluded_reason: reason };
  });
}

/** The ordered list of entries the router may try (design 2.5). Copies; never throws. */
export function effectiveChain(config) {
  return describeChain(config).filter((d) => d.in_chain).map((d) => d.entry);
}
