/**
 * Guard (Q5-TESTS): unit tests never reach the owner's live gateway on port 4100.
 * tests/setup.ts makes such a call fail fast. Without that guard this test reached the real gateway (when it runs)
 * or failed with a connection error that is not the guard's message.
 */
import { describe, expect, it } from 'vitest';

describe('unit tests and the live gateway', () => {
  it('a fetch to 127.0.0.1:4100 fails fast with the guard message', async () => {
    await expect(fetch('http://127.0.0.1:4100/api/health')).rejects.toThrow('unit tests never call the live gateway on port 4100');
  });

  it('localhost:4100 is blocked the same way', async () => {
    await expect(fetch('http://localhost:4100/api/health')).rejects.toThrow('unit tests never call the live gateway on port 4100');
  });
});
