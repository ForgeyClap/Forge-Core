/**
 * MindMapWorkspace — stubbed-fetch component tests, same pattern as discord-view.test.tsx:
 * the workspace takes the project name as a prop and reads the gateway directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { EMPTY_DETAIL, EMPTY_TITLE, MindMapWorkspace } from '@/views/mindmap/MindMapView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown): Response => ({ ok: false, status, json: async () => body }) as Response;

const LIST = {
  ok: true, available: true, provenance: 'LIVE', unreadable: 0, truncated: false,
  maps: [{ id: 'mm-plan', title: 'Overhaul plan', node_count: 4, edge_count: 3, generated_at: '2026-10-09T12:00:00.000Z' }],
};
const MAP = {
  ok: true,
  map: {
    map_id: 'mm-plan', title: 'Overhaul plan', generated_at: '2026-10-09T12:00:00.000Z',
    nodes: [
      { id: 'r', label: 'Overhaul plan', kind: 'root', parent: null },
      { id: 'a', label: 'Enforcement', kind: 'branch', parent: 'r' },
      { id: 'a1', label: 'Run contract', kind: 'leaf', parent: 'a' },
      { id: 'b', label: 'Sync safety', kind: 'leaf', parent: 'r' },
    ],
    edges: [{ from: 'r', to: 'a' }, { from: 'a', to: 'a1' }, { from: 'r', to: 'b' }],
  },
};

function route(handler: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string) => handler(String(url)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('MindMapWorkspace states', () => {
  it('shows the honest empty state when no map has been generated', async () => {
    route(() => ok({ ok: true, available: false, provenance: 'NOT GENERATED', maps: [], unreadable: 0, truncated: false }));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(EMPTY_DETAIL)).toBeInTheDocument();
    expect(EMPTY_DETAIL).toMatch(/L3\/L4 runs/);
  });

  it('shows a loading state before the gateway answers', () => {
    route(() => new Promise<Response>(() => undefined));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(screen.getByText('Loading mind maps…')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the gateway fails', async () => {
    let calls = 0;
    route(() => { calls += 1; return calls === 1 ? fail(502, { ok: false, error: 'registry down' }) : ok({ ...LIST, maps: [] }); });
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText('Could not load the mind maps')).toBeInTheDocument();
    expect(screen.getByText(/registry down/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeInTheDocument();
  });

  it('asks the gateway for the selected project only, with the id url-encoded', async () => {
    const fetchFn = route((url) => (url.includes('&id=') ? ok(MAP) : ok(LIST)));
    render(createElement(MindMapWorkspace, { projectName: 'my project' }));
    await screen.findByRole('button', { name: 'Run contract' });
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/api/mindmaps?project=my%20project'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/api/mindmaps?project=my%20project&id=mm-plan'))).toBe(true);
  });
});

describe('MindMapWorkspace with a map', () => {
  it('renders every node as a focusable button and selecting one shows its path and children', async () => {
    route((url) => (url.includes('&id=') ? ok(MAP) : ok(LIST)));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));

    const enforcement = await screen.findByRole('button', { name: 'Enforcement' });
    for (const label of ['Run contract', 'Sync safety']) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Overhaul plan' }).length).toBeGreaterThan(0);

    enforcement.focus();
    expect(document.activeElement).toBe(enforcement);
    fireEvent.click(enforcement);
    await waitFor(() => expect(enforcement).toHaveAttribute('aria-pressed', 'true'));

    const detail = screen.getByRole('region', { name: 'Selected node' });
    expect(within(detail).getByRole('heading', { name: 'Enforcement' })).toBeInTheDocument();
    expect(within(detail).getByText('Children · 1')).toBeInTheDocument();
    // Clicking a child chip in the detail panel selects that child.
    fireEvent.click(within(detail).getByRole('button', { name: 'Run contract' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Run contract' })[0]).toHaveAttribute('aria-pressed', 'true'));

    // Closing the detail card clears the selection and removes the card.
    fireEvent.click(screen.getByRole('button', { name: 'Close the node details' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected node' })).toBeNull());
    expect(screen.getByText('levels', { exact: false })).toBeInTheDocument();
  });

  it('has zoom controls and a keyboard-operable canvas', async () => {
    route((url) => (url.includes('&id=') ? ok(MAP) : ok(LIST)));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    await screen.findByRole('button', { name: 'Enforcement' });
    const canvas = screen.getByRole('group', { name: /Mind map: Overhaul plan/ });
    expect(canvas).toHaveAttribute('tabindex', '0');
    const zoom = screen.getByRole('toolbar', { name: 'Zoom' });
    const before = within(zoom).getByText(/%$/).textContent;
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(within(zoom).getByText(/%$/).textContent).not.toBe(before));
    // "0" on the canvas fits the whole map — the same view the Fit button gives.
    fireEvent.keyDown(canvas, { key: '0' });
    const fitted = within(zoom).getByText(/%$/).textContent;
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(within(zoom).getByText(/%$/).textContent).not.toBe(fitted));
    fireEvent.click(within(zoom).getByRole('button', { name: 'Fit the whole map' }));
    await waitFor(() => expect(within(zoom).getByText(/%$/).textContent).toBe(fitted));
    // Arrow keys pan without changing the zoom.
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
    expect(within(zoom).getByText(/%$/).textContent).toBe(fitted);
  });

  it('shows the map error state when one map cannot be opened', async () => {
    route((url) => (url.includes('&id=') ? fail(422, { ok: false, error: 'mind map file is not valid JSON' }) : ok(LIST)));
    render(createElement(MindMapWorkspace, { projectName: 'demo' }));
    expect(await screen.findByText('This map could not be opened')).toBeInTheDocument();
    expect(screen.getByText('mind map file is not valid JSON')).toBeInTheDocument();
  });
});
