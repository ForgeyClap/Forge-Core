/**
 * "Eigen API": the pure rules of the form (ANY-MODEL-PLAN.md §2.2 E, §2.4, Lead decisions D1/D6).
 * The gateway stays authoritative; this mirror only gives instant feedback, so every row of the §2.4
 * network table is pinned here, both the accepted and the refused side.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyBaseUrl,
  defaultAuthFor,
  draftFromEntry,
  emptyDraft,
  envNameFor,
  parseManualIds,
  toDefinition,
  urlHint,
  validateDraft,
} from '@/views/settings/sections/custom-api/custom-api-model';
import type { CustomDraft } from '@/views/settings/sections/custom-api/custom-api-model';

function draft(patch: Partial<CustomDraft>): CustomDraft {
  return { ...emptyDraft(), label: 'Mijn vLLM-server', baseURL: 'https://llm.example.org/v1', ...patch };
}

describe('classifyBaseUrl: the §2.4 network table (D1 = loopback + private ranges with a warning; all of 169.254/16 refused)', () => {
  it.each([
    ['https://llm.example.org/v1', 'https'],
    ['https://8.8.8.8/v1', 'https'],
    ['http://127.0.0.1:11434', 'local'],
    ['http://127.4.5.6:8000/v1', 'local'],
    ['http://localhost:1234/v1', 'local'],
    ['http://[::1]:8080/v1', 'local'],
    ['http://192.168.1.20:8000/v1', 'lan'],
    ['http://10.0.0.5/v1', 'lan'],
    ['http://172.16.0.1/v1', 'lan'],
    ['http://172.31.255.254/v1', 'lan'],
    ['http://[fd12:3456::1]:8000/v1', 'lan'],
    ['http://[fe80::1]/v1', 'lan'],
    ['http://nas.local:8000/v1', 'lan'],
    ['http://gpu-box.lan/v1', 'lan'],
    ['http://gpubox:8000/v1', 'lan'],
  ] as const)('%s -> %s', (url, kind) => {
    expect(classifyBaseUrl(url).kind).toBe(kind);
  });

  it.each([
    ['http://llm.example.org/v1', 'https_required'],
    ['http://8.8.8.8/v1', 'https_required'],
    ['http://172.32.0.1/v1', 'https_required'],
    ['http://169.254.169.254/latest', 'blocked_host'],
    ['https://169.254.169.254/latest', 'blocked_host'],
    ['https://metadata.google.internal/v1', 'blocked_host'],
    ['http://100.100.100.200/', 'blocked_host'],
    ['http://169.254.10.10/v1', 'blocked_host'],
    ['https://169.254.0.1/v1', 'blocked_host'],
    ['https://llm.example.org/v1?x=1', 'bad_url'],
    ['http://[fd00:ec2::254]/', 'blocked_host'],
    ['https://mail.example.org:25/v1', 'blocked_port'],
    ['https://mail.example.org:587/v1', 'blocked_port'],
    ['http://127.0.0.1:0/', 'blocked_port'],
    ['ftp://files.example.org/', 'bad_url'],
    ['https://user:pass@llm.example.org/v1', 'bad_url'],
    ['https://llm.example.org/v1#part', 'bad_url'],
    ['llm.example.org/v1', 'bad_url'],
    ['https://llm example.org', 'bad_url'],
  ] as const)('%s is refused with %s', (url, code) => {
    expect(classifyBaseUrl(url)).toEqual({ kind: 'error', code });
  });

  it('an empty address is empty, not an error', () => {
    expect(classifyBaseUrl('   ').kind).toBe('empty');
  });
});

describe('urlHint: soft hints per format (never an error)', () => {
  it('OpenAI style without /v1 gets the /v1 hint; with /v1 none', () => {
    expect(urlHint('openai-chat', 'http://127.0.0.1:8000')).toBe('openaiV1');
    expect(urlHint('openai-chat', 'http://127.0.0.1:8000/v1')).toBeNull();
    expect(urlHint('openai-responses', 'https://llm.example.org/v1/')).toBeNull();
  });

  it('Anthropic style ending in /v1 gets the "leave /v1 out" hint', () => {
    expect(urlHint('anthropic', 'https://proxy.example.org/v1')).toBe('anthropicNoV1');
    expect(urlHint('anthropic', 'https://proxy.example.org')).toBeNull();
  });

  it('no hint for an address that does not parse', () => {
    expect(urlHint('openai-chat', 'not a url')).toBeNull();
  });
});

describe('validateDraft', () => {
  it('a complete draft has no issues', () => {
    expect(validateDraft(draft({}))).toEqual([]);
  });

  it('name: required, at most 40 characters, no control characters', () => {
    expect(validateDraft(draft({ label: '  ' }))).toContainEqual({ field: 'label', code: 'required' });
    expect(validateDraft(draft({ label: 'x'.repeat(41) }))).toContainEqual({ field: 'label', code: 'tooLong' });
    expect(validateDraft(draft({ label: 'a\u0007b' }))).toContainEqual({ field: 'label', code: 'control' });
  });

  it('a key pasted into the name or the address is refused here, before it can travel', () => {
    expect(validateDraft(draft({ label: 'sk-abcdefghijklmnop1234' }))).toContainEqual({ field: 'label', code: 'secretLike' });
    expect(validateDraft(draft({ baseURL: 'https://llm.example.org/v1?key=abcdef123456' }))).toContainEqual({
      field: 'baseURL',
      code: 'secretLike',
    });
  });

  it('address: required and every refusal of the network table', () => {
    expect(validateDraft(draft({ baseURL: '' }))).toContainEqual({ field: 'baseURL', code: 'required' });
    expect(validateDraft(draft({ baseURL: 'http://llm.example.org/v1' }))).toContainEqual({ field: 'baseURL', code: 'https_required' });
    expect(validateDraft(draft({ baseURL: 'http://192.168.1.20:8000/v1' }))).toEqual([]);
  });

  it('own header: a valid name that is not an auth header with its own choice; no control characters in the prefix', () => {
    expect(validateDraft(draft({ authType: 'custom', header: '' }))).toContainEqual({ field: 'header', code: 'required' });
    expect(validateDraft(draft({ authType: 'custom', header: 'X Auth' }))).toContainEqual({ field: 'header', code: 'badHeader' });
    expect(validateDraft(draft({ authType: 'custom', header: 'Authorization' }))).toContainEqual({ field: 'header', code: 'reservedHeader' });
    expect(validateDraft(draft({ authType: 'custom', header: 'cookie' }))).toContainEqual({ field: 'header', code: 'reservedHeader' });
    expect(validateDraft(draft({ authType: 'custom', header: 'X-Auth-Token' }))).toEqual([]);
    expect(validateDraft(draft({ authType: 'custom', header: 'X-Auth-Token', prefix: 'Token\u0000' }))).toContainEqual({
      field: 'prefix',
      code: 'control',
    });
    // The header fields do not count when no key is needed or another way is chosen.
    expect(validateDraft(draft({ authType: 'bearer', header: 'X Auth' }))).toEqual([]);
    expect(validateDraft(draft({ noKey: true, authType: 'custom', header: '' }))).toEqual([]);
  });

  it('models: the manual list needs at least one valid id (D6)', () => {
    expect(validateDraft(draft({ modelsMode: 'manual', manualIds: '' }))).toContainEqual({ field: 'models', code: 'required' });
    expect(validateDraft(draft({ modelsMode: 'manual', manualIds: 'qwen2.5-coder:32b\nbad id' }))).toContainEqual({
      field: 'models',
      code: 'badModel',
    });
    expect(validateDraft(draft({ modelsMode: 'manual', manualIds: 'qwen2.5-coder:32b\nmeta/llama-3.1-8b' }))).toEqual([]);
    expect(validateDraft(draft({ modelsMode: 'endpoint', manualIds: 'bad id' }))).toEqual([]);
  });

  it('context length: empty, or a whole number in range', () => {
    expect(validateDraft(draft({ contextLength: '' }))).toEqual([]);
    expect(validateDraft(draft({ contextLength: '32768' }))).toEqual([]);
    expect(validateDraft(draft({ contextLength: '12.5' }))).toContainEqual({ field: 'contextLength', code: 'outOfRange' });
    expect(validateDraft(draft({ contextLength: '100' }))).toContainEqual({ field: 'contextLength', code: 'outOfRange' });
  });
});

describe('parseManualIds', () => {
  it('one id per line, trimmed, blank lines and duplicates dropped, the bad ones named', () => {
    expect(parseManualIds(' a:1 \n\nb/c\na:1\nbad id\n')).toEqual({ ids: ['a:1', 'b/c'], bad: ['bad id'] });
  });
});

describe('toDefinition: the wire shape of §2.2 A, never a key', () => {
  it('OpenAI chat with the default auth', () => {
    expect(toDefinition(draft({ contextLength: '32768' }))).toEqual({
      label: 'Mijn vLLM-server',
      format: 'openai-chat',
      baseURL: 'https://llm.example.org/v1',
      auth: { type: 'bearer' },
      models: { mode: 'endpoint' },
      extraHeaders: {},
      contextLength: 32768,
      enabled: true,
    });
  });

  it('Anthropic defaults to x-api-key; no key means auth none; a custom header carries name and prefix', () => {
    expect(toDefinition(draft({ format: 'anthropic' })).auth).toEqual({ type: 'x-api-key' });
    expect(toDefinition(draft({ noKey: true, authType: 'custom', header: 'X-A' })).auth).toEqual({ type: 'none' });
    expect(toDefinition(draft({ authType: 'custom', header: 'X-Auth-Token', prefix: 'Token ' })).auth).toEqual({
      type: 'custom',
      header: 'X-Auth-Token',
      prefix: 'Token ',
    });
    expect(toDefinition(draft({ modelsMode: 'manual', manualIds: 'a\nb' })).models).toEqual({ mode: 'manual', ids: ['a', 'b'] });
  });

  it('round-trips through draftFromEntry', () => {
    const def = toDefinition(draft({ format: 'openai-responses', authType: 'api-key-header', modelsMode: 'manual', manualIds: 'm1', enabled: false }));
    const back = draftFromEntry({ id: 'custom-mijn-vllm-server', ...def, createdAt: null, updatedAt: null });
    expect(toDefinition(back)).toEqual(def);
  });
});

describe('names', () => {
  it('the default auth per format', () => {
    expect(defaultAuthFor('openai-chat')).toBe('bearer');
    expect(defaultAuthFor('openai-responses')).toBe('bearer');
    expect(defaultAuthFor('anthropic')).toBe('x-api-key');
  });

  it('the derived key name of §2.2 C (dev tree: the env name, D2)', () => {
    expect(envNameFor('custom-mijn-vllm')).toBe('CUSTOM_MIJN_VLLM_API_KEY');
    expect(envNameFor('openai')).toBeNull();
  });
});
