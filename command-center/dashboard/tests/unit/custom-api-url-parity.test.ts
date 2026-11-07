/**
 * fix lane — the form's address check and the gateway's address check give the SAME answer.
 *
 * The dashboard mirror (`custom-api-model.ts` classifyBaseUrl) only gives instant feedback; the gateway's
 * `custom-rules.mjs` checkCustomURL is authoritative (ANY-MODEL-PLAN.md §2.4, Lead decision D1). When the
 * two disagree, a person sees "allowed" in the form and a refusal on Opslaan (or the other way round).
 * This test runs BOTH over one table and expects identical classes, so any drift fails here.
 *
 * Inputs are what the form sends: `toDefinition` trims the address, so the table holds trimmed values.
 * The empty string is left out on purpose: the form shows "required" for it (kind `empty`), the gateway
 * says bad_url; both refuse it.
 */

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { classifyBaseUrl } from '@/views/settings/sections/custom-api/custom-api-model';

type ServerVerdict =
  | { readonly ok: true; readonly urlClass: 'https' | 'loopback' | 'lan' }
  | { readonly ok: false; readonly code: string };

// The gateway's plain .mjs is loaded by Node itself (require of an ES module, Node 22.12+), not by Vite:
// Vite will not load a file outside the dashboard folder, and a variable path keeps TypeScript from
// wanting a declaration file for it.
const GATEWAY_RULES = '../../../gateway/src/providers/custom-rules.mjs';
const nodeRequire = createRequire(import.meta.url);

function serverRules(): (raw: string) => ServerVerdict {
  const mod = nodeRequire(GATEWAY_RULES) as { checkCustomURL: (raw: string) => ServerVerdict };
  return mod.checkCustomURL;
}

function serverClass(verdict: ServerVerdict): string {
  if (!verdict.ok) return verdict.code;
  return verdict.urlClass === 'loopback' ? 'local' : verdict.urlClass;
}

function clientClass(raw: string): string {
  const verdict = classifyBaseUrl(raw);
  return verdict.kind === 'error' ? verdict.code : verdict.kind;
}

/** [address, the class both must give]. Every row of the §2.4 table, accepted and refused sides. */
const TABLE: readonly (readonly [string, string])[] = [
  // https: any normal host.
  ['https://llm.example.org/v1', 'https'],
  ['https://8.8.8.8/v1', 'https'],
  ['https://api.openai.com/v1', 'https'],
  ['https://192.168.1.20:8443/v1', 'https'],
  ['https://[2001:db8::1]/v1', 'https'],
  ['HTTPS://LLM.EXAMPLE.ORG/v1', 'https'],
  ['https://bücher.example/v1', 'https'],
  // http to this computer.
  ['http://127.0.0.1:11434', 'local'],
  ['http://127.4.5.6:8000/v1', 'local'],
  ['http://localhost:1234/v1', 'local'],
  ['http://LOCALHOST:1234/v1', 'local'],
  ['http://localhost.localdomain:8000/v1', 'https_required'],
  ['http://[::1]:8080/v1', 'local'],
  ['http://127.1:8000/v1', 'local'],
  ['http://0x7f.1:8000/v1', 'local'],
  ['http://2130706433:8000/v1', 'local'],
  ['http://[::ffff:127.0.0.1]:8000/v1', 'local'],
  // http to the home network: allowed with the visible warning.
  ['http://192.168.1.20:8000/v1', 'lan'],
  ['http://10.0.0.5/v1', 'lan'],
  ['http://172.16.0.1/v1', 'lan'],
  ['http://172.31.255.254/v1', 'lan'],
  ['http://[fd12:3456::1]:8000/v1', 'lan'],
  ['http://[fc00::1]/v1', 'lan'],
  ['http://[fe80::1]/v1', 'lan'],
  ['http://[::ffff:192.168.1.9]/v1', 'lan'],
  ['http://nas.local:8000/v1', 'lan'],
  ['http://gpu-box.lan/v1', 'lan'],
  ['http://gpubox:8000/v1', 'lan'],
  ['http://gpu_box.lan/v1', 'lan'],
  // A name UNDER .localhost is not resolved by the gateway, so it counts as a home-network name, never local.
  ['http://ollama.localhost:11434', 'lan'],
  // http to a public host: https required.
  ['http://llm.example.org/v1', 'https_required'],
  ['http://8.8.8.8/v1', 'https_required'],
  ['http://172.32.0.1/v1', 'https_required'],
  ['http://172.15.0.1/v1', 'https_required'],
  ['http://100.64.0.1/v1', 'https_required'],
  ['http://[2001:db8::1]/v1', 'https_required'],
  ['http://[fc::1]/v1', 'https_required'],
  ['http://[fe8::1]/v1', 'https_required'],
  // All of 169.254.0.0/16 (link-local, home of the metadata services) and the metadata hosts: always refused.
  ['http://169.254.169.254/latest', 'blocked_host'],
  ['https://169.254.169.254/latest', 'blocked_host'],
  ['http://169.254.10.10/v1', 'blocked_host'],
  ['https://169.254.10.10/v1', 'blocked_host'],
  ['http://169.254.0.1/', 'blocked_host'],
  ['http://169.254.255.255/', 'blocked_host'],
  ['http://[::ffff:169.254.169.254]/', 'blocked_host'],
  ['http://[::ffff:a9fe:a9fe]/', 'blocked_host'],
  ['https://metadata.google.internal/v1', 'blocked_host'],
  ['http://metadata.google.internal/v1', 'blocked_host'],
  ['http://metadata/v1', 'blocked_host'],
  ['http://instance-data/latest', 'blocked_host'],
  ['https://instance-data.ec2.internal/latest', 'blocked_host'],
  ['http://100.100.100.200/', 'blocked_host'],
  ['https://100.100.100.200/', 'blocked_host'],
  ['http://[fd00:ec2::254]/', 'blocked_host'],
  ['https://[fd00:ec2::254]/', 'blocked_host'],
  ['http://0.0.0.0:8000/', 'blocked_host'],
  ['http://224.0.0.1/', 'blocked_host'],
  ['http://255.255.255.255/', 'blocked_host'],
  ['http://[::]:8000/', 'blocked_host'],
  ['http://[ff02::1]/', 'blocked_host'],
  // A blocked host wins over a blocked port (the gateway checks the host first).
  ['http://169.254.169.254:25/', 'blocked_host'],
  // Well-known non-web ports.
  ['https://mail.example.org:25/v1', 'blocked_port'],
  ['https://mail.example.org:587/v1', 'blocked_port'],
  ['https://mail.example.org:465/v1', 'blocked_port'],
  ['http://127.0.0.1:0/', 'blocked_port'],
  ['http://192.168.1.2:110/', 'blocked_port'],
  ['http://localhost:143/', 'blocked_port'],
  // Not a usable address.
  ['ftp://files.example.org/', 'bad_url'],
  ['https://user:pass@llm.example.org/v1', 'bad_url'],
  ['https://llm.example.org/v1#part', 'bad_url'],
  ['https://llm.example.org/v1?key=1', 'bad_url'],
  ['https://llm.example.org/v1?', 'bad_url'],
  ['https://llm.example.org/v1/@me', 'bad_url'],
  ['https://llm.example.org/{v1}', 'bad_url'],
  ['https://llm.example.org\\v1', 'bad_url'],
  ['llm.example.org/v1', 'bad_url'],
  ['https://llm example.org', 'bad_url'],
  ['http:llm.example.org/v1', 'bad_url'],
  ['http:/llm.example.org/v1', 'bad_url'],
  ['https://llm.example.org./v1', 'bad_url'],
  ['http://localhost./v1', 'bad_url'],
  ['https://', 'bad_url'],
  [`https://llm.example.org/${'a'.repeat(300)}`, 'bad_url'],
  ['https://llm.example.org/v1\u0007', 'bad_url'],
];

describe('the form and the gateway judge an address the same way (§2.4)', () => {
  it.each(TABLE)('%s -> %s on both sides', (address, expected) => {
    const checkCustomURL = serverRules();
    expect({ server: serverClass(checkCustomURL(address)), client: clientClass(address) }).toEqual({ server: expected, client: expected });
  });

  it('the whole link-local block is refused on both sides, http and https', () => {
    const checkCustomURL = serverRules();
    for (const third of [0, 1, 99, 169, 254, 255]) {
      for (const scheme of ['http', 'https']) {
        const address = `${scheme}://169.254.${third}.7/v1`;
        expect([address, serverClass(checkCustomURL(address)), clientClass(address)]).toEqual([address, 'blocked_host', 'blocked_host']);
      }
    }
  });
});
