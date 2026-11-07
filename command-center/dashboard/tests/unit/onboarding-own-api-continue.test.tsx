/**
 * Q5-EIGEN-API-UI, Review Boss medium (owner-queue-4 seq 75): on the onboarding "Eigen API" step, "Verder"
 * was enabled before anything was saved. It is now enabled only once an own API entry is saved (or one was
 * already saved before), and the step says why it waits. The API-sleutel path is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { setLocale } from '@/i18n';
import OnboardingView from '@/views/onboarding/OnboardingView';
import type { OnboardingViewProps } from '@/views/onboarding/OnboardingView';

const SAVED = {
  id: 'custom-mijn-vllm',
  label: 'Mijn vLLM',
  format: 'openai-chat',
  baseURL: 'http://192.168.1.20:8000/v1',
  auth: { type: 'bearer' },
  models: { mode: 'endpoint' },
  extraHeaders: {},
  contextLength: null,
  enabled: true,
};

function stubGateway({ existing = [] as unknown[], createStatus = 201 } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let status = 200;
      let body: unknown = {};
      if (url.endsWith('/api/providers/custom') && method === 'GET') body = { ok: true, revision: 0, providers: existing };
      else if (url.endsWith('/api/providers/custom') && method === 'POST') {
        status = createStatus;
        body = createStatus === 201 ? { ok: true, revision: 1, provider: SAVED } : { ok: false, errors: [{ path: 'baseURL', code: 'blocked_host', nl: 'Dit adres mag niet.', en: 'Not allowed.' }] };
      }
      return { ok: status < 400, status, json: async () => body } as Response;
    }),
  );
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function renderWizard(props: OnboardingViewProps) {
  return render(createElement(MemoryRouter, null, createElement(OnboardingView, props)));
}

function fill(label: string, value: string) {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

const next = () => screen.getByRole('button', { name: 'Verder' });

describe('onboarding Eigen API: Verder only after a save', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('nothing saved yet: Verder is off and the step says to save first', async () => {
    stubGateway();
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    expect(next()).toBeDisabled();
    expect(screen.getByText('Sla eerst je eigen API op; daarna kun je verder.')).toBeInTheDocument();
  });

  it('a refused save keeps Verder off; a successful save turns it on', async () => {
    stubGateway({ createStatus: 400 });
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(next()).toBeDisabled();
    cleanup();
    vi.unstubAllGlobals();

    stubGateway();
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    fill('Naam', 'Mijn vLLM');
    fill('Adres (base URL)', 'http://192.168.1.20:8000/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Opslaan' }));
    await settle();
    expect(next()).toBeEnabled();
    expect(screen.queryByText('Sla eerst je eigen API op; daarna kun je verder.')).toBeNull();
  });

  it('an own API that was saved before also counts', async () => {
    stubGateway({ existing: [SAVED] });
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    expect(next()).toBeEnabled();
  });

  it('switching back to the API-sleutel path keeps its own rule (Verder on)', async () => {
    stubGateway();
    renderWizard({ initialStep: 'verbinden', initialPath: 'eigen' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Toch een dienst uit de lijst' }));
    expect(next()).toBeEnabled();
  });
});
