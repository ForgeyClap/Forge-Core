/**
 * WP B3 — permission cards: the fixed rule table (tool_name + input -> plain Dutch first line +
 * badges) and the card behaviour (three answers, the group card, a failed answer, never "failed").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { setLocale } from '@/i18n';
import { translate } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { PermissionCard, PermissionCards } from '@/views/chat/permissions/PermissionCard';
import { describePermission, isOutside, normalizePath, splitCommands } from '@/views/chat/permissions/permission-rules';
import type { PendingPermission } from '@/views/chat/permissions/permission-types';

const PROJECT = 'C:\\Users\\iemand\\Documents\\Forge Projecten\\bakkerij';

function req(tool_name: string, input: Record<string, unknown>, extra: Partial<PendingPermission> = {}): PendingPermission {
  return { id: `p-${tool_name}-${Math.random().toString(36).slice(2, 7)}`, tool_name, input, created_at: '2026-11-02T10:00:00Z', ...extra };
}

function firstLine(request: PendingPermission, projectDir: string | null = PROJECT): string {
  const d = describePermission(request, projectDir);
  return translate('nl', `chatCards.permissions.summary.${d.kind}` as MessageKey, d.vars);
}

describe('permission rule table (fixed, not from the model)', () => {
  it.each([
    ['npm install', 'Programmaonderdelen downloaden van internet (npm)', ['internet']],
    ['npm i react', 'Programmaonderdelen downloaden van internet (npm)', ['internet']],
    ['pnpm add zod', 'Programmaonderdelen downloaden van internet (pnpm)', ['internet']],
    ['pip install requests', 'Programmaonderdelen downloaden van internet (pip)', ['internet']],
    ['npx create-vite@latest site', 'Een programma van internet starten (npx)', ['internet']],
    ['rm index.html', '1 bestand verwijderen: index.html', ['deletes']],
    ['del a.css b.css c.css d.css', '4 bestanden verwijderen: a.css, b.css, c.css, …', ['deletes']],
    ['rm -rf dist', 'Een map met alles erin verwijderen: dist', ['deletes']],
    ['Remove-Item -Recurse -Force build', 'Een map met alles erin verwijderen: build', ['deletes']],
    ['git push origin main', 'Wijzigingen online zetten (git push)', ['internet']],
    ['git commit -m "start"', 'Een versie vastleggen (git commit)', []],
    ['curl https://example.com/data.json', 'Iets van internet ophalen (curl)', ['internet']],
    ['npm run build', 'Een opdracht uit het project uitvoeren: npm run build', []],
    ['ls -la', 'Opdracht uitvoeren: ls -la', []],
  ])('Bash %j -> %j', (command, line, badges) => {
    const request = req('Bash', { command });
    expect(firstLine(request)).toBe(line);
    expect(describePermission(request, PROJECT).badges).toEqual(badges);
  });

  // Review fix (B3-cards): commands that throw away work get the "verwijdert iets" badge
  // and their own first line; ordinary checkouts and soft resets do not.
  it.each([
    ['git reset --hard', 'Niet-opgeslagen wijzigingen weggooien (git reset)', ['deletes']],
    ['git reset --hard HEAD~1', 'Niet-opgeslagen wijzigingen weggooien (git reset)', ['deletes']],
    ['git checkout -- src/app.ts', 'Niet-opgeslagen wijzigingen weggooien (git checkout)', ['deletes']],
    ['git checkout .', 'Niet-opgeslagen wijzigingen weggooien (git checkout)', ['deletes']],
    ['git restore index.html', 'Niet-opgeslagen wijzigingen weggooien (git restore)', ['deletes']],
    ['git clean -fd', 'Nieuwe, nog niet vastgelegde bestanden verwijderen (git clean)', ['deletes']],
    ['git checkout main', 'Opdracht uitvoeren: git checkout main', []],
    ['git reset HEAD~1', 'Opdracht uitvoeren: git reset HEAD~1', []],
    ['git restore --staged index.html', 'Opdracht uitvoeren: git restore --staged index.html', []],
  ])('discarding work: %j -> %j', (command, line, badges) => {
    const request = req('Bash', { command });
    expect(firstLine(request)).toBe(line);
    expect(describePermission(request, PROJECT).badges).toEqual(badges);
  });

  it.each([
    ['Remove-Item -Force build.log', '1 bestand verwijderen: build.log'],
    ['Remove-Item -Verbose oud.txt', '1 bestand verwijderen: oud.txt'],
    ['rm -f notes.txt', '1 bestand verwijderen: notes.txt'],
    ['rm -r tmp', 'Een map met alles erin verwijderen: tmp'],
    ['rm -R tmp', 'Een map met alles erin verwijderen: tmp'],
    ['rm -fr tmp', 'Een map met alles erin verwijderen: tmp'],
    ['rm --recursive tmp', 'Een map met alles erin verwijderen: tmp'],
    ['Remove-Item -Recurse oud', 'Een map met alles erin verwijderen: oud'],
    ['del /s oud', 'Een map met alles erin verwijderen: oud'],
  ])('only the real recursive flags make a folder delete: %j', (command, line) => {
    expect(firstLine(req('Bash', { command }))).toBe(line);
  });

  it.each([
    ['bash -c "rm -rf dist"', 'Een map met alles erin verwijderen: dist', ['deletes'], 0],
    ["sh -c 'npm install && rm -rf dist'", 'Een map met alles erin verwijderen: dist', ['deletes', 'internet'], 1],
    ['powershell -Command "Remove-Item -Recurse -Force C:\\elders\\oud"', 'Een map met alles erin verwijderen: oud', ['deletes', 'outside'], 0],
    ['pwsh -Command "Invoke-WebRequest https://example.com -OutFile x.zip"', 'Iets van internet ophalen (invoke-webrequest)', ['internet'], 0],
    ['cmd /c "del a.txt"', '1 bestand verwijderen: a.txt', ['deletes'], 0],
    ['cmd /c del a.txt', '1 bestand verwijderen: a.txt', ['deletes'], 0],
  ])('a shell inside a shell is judged by what it runs: %j', (command, line, badges, more) => {
    const d = describePermission(req('Bash', { command }), PROJECT);
    expect(firstLine(req('Bash', { command }))).toBe(line);
    expect(d.badges).toEqual(badges);
    expect(d.moreCommands).toBe(more);
  });

  it('badges are the union of the rule table and the gateway categories: the card never warns less than the gateway', () => {
    const quiet = req('Bash', { command: 'node scripts/build.mjs' }, { categories: ['network', 'delete', 'outside_folder', 'exec', 'edit'] });
    expect(describePermission(quiet, PROJECT).badges).toEqual(['deletes', 'internet', 'outside']);
    const tool = req('Edit', { file_path: `${PROJECT}\\a.css` }, { categories: ['outside_folder'] });
    expect(describePermission(tool, PROJECT).badges).toEqual(['outside']);
    // Unknown categories are ignored, never guessed at.
    const odd = req('Read', { file_path: `${PROJECT}\\a.css` }, { categories: ['exec', 'whatever'] });
    expect(describePermission(odd, PROJECT).badges).toEqual([]);
  });

  it('a chained line is named after its heaviest command, with the rest counted and every badge kept', () => {
    const d = describePermission(req('Bash', { command: 'cd site && npm install && rm -rf .cache' }), PROJECT);
    expect(d.kind).toBe('deleteFolder');
    expect(d.moreCommands).toBe(1); // npm install; `cd` does not count
    expect(d.badges).toEqual(['deletes', 'internet']);
  });

  it('a long unknown command is cut short in the first line, but complete under Technische details', () => {
    const command = `node scripts/generate.mjs --input ${'x'.repeat(120)}`;
    const d = describePermission(req('Bash', { command }), PROJECT);
    expect(firstLine(req('Bash', { command }))).toMatch(/^Opdracht uitvoeren: node scripts\/generate\.mjs .*…$/);
    expect(d.technical).toBe(command);
  });

  it('file tools: one file, by its name, with "buiten deze map" when the path leaves the project', () => {
    expect(firstLine(req('Write', { file_path: `${PROJECT}\\index.html`, content: '<h1>' }))).toBe('1 bestand maken of vervangen: index.html');
    expect(firstLine(req('Edit', { file_path: `${PROJECT}\\css\\site.css` }))).toBe('1 bestand aanpassen: site.css');
    expect(describePermission(req('Edit', { file_path: `${PROJECT}\\css\\site.css` }), PROJECT).badges).toEqual([]);
    expect(describePermission(req('Write', { file_path: 'C:\\Windows\\hosts' }), PROJECT).badges).toEqual(['outside']);
    expect(describePermission(req('Bash', { command: 'rm ..\\..\\andere-klant\\index.html' }), PROJECT).badges).toEqual(['deletes', 'outside']);
  });

  it('web, search, connections, helpers and an unknown tool', () => {
    expect(firstLine(req('WebFetch', { url: 'https://www.korenaar.nl/menu' }))).toBe('Een webpagina ophalen: www.korenaar.nl');
    expect(describePermission(req('WebSearch', { query: 'bakkerij openingstijden' })).badges).toEqual(['internet']);
    expect(firstLine(req('mcp__n8n_mcp__create_workflow', {}))).toBe('Een koppeling gebruiken: n8n_mcp');
    expect(firstLine(req('Task', { description: 'Test op telefoonformaat' }))).toBe('Een extra helper inschakelen: Test op telefoonformaat');
    expect(firstLine(req('SomethingNew', {}))).toBe('Iets doen met SomethingNew');
  });

  it('path helpers: Git-Bash paths, ".." and a missing project folder', () => {
    expect(normalizePath('/c/Users/Iemand/x')).toBe('c:/users/iemand/x');
    expect(isOutside('/c/Users/iemand/Documents/Forge Projecten/bakkerij/a.txt', PROJECT)).toBe(false);
    expect(isOutside('..\\x.txt', PROJECT)).toBe(true);
    expect(isOutside('C:\\elders\\x.txt', null)).toBe(false);
    expect(isOutside('~/.ssh/id_rsa', null)).toBe(true);
    expect(splitCommands('a "b && c" && d; e | f')).toEqual(['a "b && c"', 'd', 'e', 'f']);
  });
});

describe('permission cards (render)', () => {
  beforeEach(() => setLocale('nl'));
  afterEach(() => cleanup());

  it('one request: Dutch first line, badges, folded technical details, three answers', async () => {
    const onAnswer = vi.fn(async () => undefined);
    const request = req('Bash', { command: 'npm install' }, { id: 'p1', agent: 'Build Boss' });
    render(<PermissionCard request={request} projectDir={PROJECT} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading', { name: 'Programmaonderdelen downloaden van internet (npm)' })).toBeInTheDocument();
    expect(screen.getByText('Wacht op jou')).toBeInTheDocument();
    expect(screen.getByText(/Bouwer vraagt of dit mag/)).toBeInTheDocument();
    expect(screen.getByText('gebruikt internet')).toBeInTheDocument();
    const details = screen.getByText('Technische details').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details as HTMLElement).getByText('npm install')).toBeInTheDocument();
    expect(screen.getByText(/Het werk staat stil tot je kiest/)).toBeInTheDocument();
    expect(screen.queryByText(/Mislukt/)).toBeNull();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Toestaan' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Altijd toestaan in dit gesprek' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Niet doen' })));
    expect(onAnswer.mock.calls).toEqual([
      ['p1', 'allow'],
      ['p1', 'allow_session'],
      ['p1', 'deny'],
    ]);
  });

  it('an answer that does not arrive says so, and the buttons work again', async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error('404');
    });
    render(<PermissionCard request={req('Bash', { command: 'rm index.html' }, { id: 'p2' })} projectDir={PROJECT} onAnswer={onAnswer} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Toestaan' })));
    expect(screen.getByText('Je antwoord kwam niet aan. Probeer het opnieuw.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toestaan' })).toBeEnabled();
  });

  it('a request the gateway would never remember (rememberable:false) offers no "Altijd toestaan in dit gesprek", with its own reason', () => {
    // Contract addition 2026-11-02: Bash/PowerShell requests are never remembered by the gateway (empty allow-list),
    // so the card must not promise a session rule it cannot keep.
    render(<PermissionCard request={req('Bash', { command: 'ls' }, { id: 'p7', rememberable: false })} projectDir={PROJECT} onAnswer={vi.fn(async () => undefined)} />);
    expect(screen.queryByRole('button', { name: 'Altijd toestaan in dit gesprek' })).toBeNull();
    expect(screen.getByText('Altijd toestaan geldt hier niet: dit soort opdracht wordt nooit onthouden, Forge vraagt het elke keer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toestaan' })).toBeInTheDocument();
  });

  it('an absent rememberable flag (older gateway) keeps the session button for a single command', () => {
    render(<PermissionCard request={req('Read', { file_path: PROJECT + '/README.md' }, { id: 'p8' })} projectDir={PROJECT} onAnswer={vi.fn(async () => undefined)} />);
    expect(screen.getByRole('button', { name: 'Altijd toestaan in dit gesprek' })).toBeInTheDocument();
  });
  it('a line with more than one command offers no "Altijd toestaan in dit gesprek", and says why', () => {
    const onAnswer = vi.fn();
    const chained = req('Bash', { command: 'npm install && rm -rf dist' }, { id: 'p-chain' });
    render(<PermissionCard request={chained} projectDir={PROJECT} onAnswer={onAnswer} />);
    expect(screen.queryByRole('button', { name: 'Altijd toestaan in dit gesprek' })).toBeNull();
    expect(screen.getByText('Altijd toestaan kan hier niet: dit zijn meerdere opdrachten tegelijk.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toestaan' })).toBeInTheDocument();
    cleanup();
    const write = req('Write', { file_path: `${PROJECT}\\a.html` }, { id: 'p-w', created_at: '2026-11-02T10:01:00Z' });
    render(<PermissionCards pending={[chained, write]} projectDir={PROJECT} onAnswer={onAnswer} />);
    const chainItem = document.querySelector('[data-permission-id="p-chain"]') as HTMLElement;
    const writeItem = document.querySelector('[data-permission-id="p-w"]') as HTMLElement;
    expect(within(chainItem).queryByRole('button', { name: 'Altijd in dit gesprek' })).toBeNull();
    expect(within(chainItem).getByText('Altijd toestaan kan hier niet: dit zijn meerdere opdrachten tegelijk.')).toBeInTheDocument();
    expect(within(writeItem).getByRole('button', { name: 'Altijd in dit gesprek' })).toBeInTheDocument();
  });

  it('nothing pending renders nothing', () => {
    const { container } = render(<PermissionCards pending={[]} onAnswer={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('several requests become one group card with an answer per line and "Alles toestaan"', async () => {
    const onAnswer = vi.fn(async () => undefined);
    const pending = [
      req('Bash', { command: 'npm install' }, { id: 'a', agent: 'Build Boss', created_at: '2026-11-02T10:00:02Z' }),
      req('Write', { file_path: `${PROJECT}\\index.html` }, { id: 'b', agent: 'UI Boss', created_at: '2026-11-02T10:00:01Z' }),
      req('Bash', { command: 'rm old.html' }, { id: 'c', agent: 'Build Boss', created_at: '2026-11-02T10:00:03Z' }),
      req('WebFetch', { url: 'https://example.com' }, { id: 'd', agent: 'Search Boss', created_at: '2026-11-02T10:00:04Z' }),
    ];
    render(<PermissionCards pending={pending} projectDir={PROJECT} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading', { name: 'Het team wil 4 dingen doen' })).toBeInTheDocument();
    const items = screen.getByRole('list', { name: 'Verzoeken van het team' }).querySelectorAll(':scope > li');
    expect(Array.from(items).map((item) => item.getAttribute('data-permission-id'))).toEqual(['b', 'a', 'c', 'd']);
    expect(within(items[0] as HTMLElement).getByText('Ontwerper')).toBeInTheDocument();

    await act(async () => fireEvent.click(within(items[2] as HTMLElement).getByRole('button', { name: 'Niet doen' })));
    expect(onAnswer).toHaveBeenLastCalledWith('c', 'deny');
    await act(async () => fireEvent.click(within(items[1] as HTMLElement).getByRole('button', { name: 'Altijd in dit gesprek' })));
    expect(onAnswer).toHaveBeenLastCalledWith('a', 'allow_session');

    onAnswer.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Alles toestaan' })));
    expect(onAnswer.mock.calls.map((call) => call.join(':'))).toEqual(['b:allow', 'a:allow', 'c:allow', 'd:allow']);
  });
});

describe('usePendingPermissions (data side)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('parses only well-formed rows, answers through the contract route and drops the answered row', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { usePendingPermissions, parsePending } = await import('@/views/chat/permissions/use-pending-permissions');
    expect(parsePending({ pending: [{ id: 'x', tool_name: 'Bash', input: { command: 'ls' } }, { id: 1 }, null, 'junk'] })).toHaveLength(1);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
        const body = String(url).includes('/pending')
          ? { ok: true, pending: calls.some((c) => c.startsWith('POST')) ? [] : [{ id: 'p9', tool_name: 'Bash', input: { command: 'npm install' }, created_at: '2026-11-02T10:00:00Z' }] }
          : { ok: true };
        return { ok: true, status: 200, json: async () => body } as Response;
      }),
    );
    const { result } = renderHook(() => usePendingPermissions('c1', 60_000));
    await waitFor(() => expect(result.current.pending.map((p) => p.id)).toEqual(['p9']));
    await act(async () => result.current.answer('p9', 'allow_session'));
    expect(calls).toContain('POST /api/permissions/p9/answer');
    expect(calls[0]).toBe('GET /api/permissions/pending?conversation=c1');
    await waitFor(() => expect(result.current.pending).toEqual([]));
  });

  it('switching conversations: an old answer never shows under the new conversation', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { usePendingPermissions } = await import('@/views/chat/permissions/use-pending-permissions');
    let releaseC1: (() => void) | null = null;
    const row = (id: string) => ({ id, tool_name: 'Bash', input: { command: 'npm install' }, created_at: '2026-11-02T10:00:00Z' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('conversation=c1')) {
          // c1 answers only when the test says so: after the switch to c2.
          await new Promise<void>((resolve) => {
            releaseC1 = resolve;
          });
          return { ok: true, status: 200, json: async () => ({ ok: true, pending: [row('from-c1')] }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, pending: [] }) } as Response;
      }),
    );
    const { result, rerender } = renderHook(({ id }) => usePendingPermissions(id, 60_000), { initialProps: { id: 'c1' } });
    await waitFor(() => expect(releaseC1).not.toBeNull());
    rerender({ id: 'c2' });
    await act(async () => {
      releaseC1!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.pending.map((p) => p.id)).toEqual([]);
  });

  it('switching conversations clears the old list before the new one has answered; categories pass through', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { usePendingPermissions, parsePending } = await import('@/views/chat/permissions/use-pending-permissions');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('conversation=c1'))
          return { ok: true, status: 200, json: async () => ({ ok: true, pending: [{ id: 'old', tool_name: 'Write', input: {}, categories: ['outside_folder', 7] }] }) } as Response;
        return new Promise<Response>(() => undefined); // c2 never answers
      }),
    );
    const { result, rerender } = renderHook(({ id }) => usePendingPermissions(id, 60_000), { initialProps: { id: 'c1' } });
    await waitFor(() => expect(result.current.pending.map((p) => p.id)).toEqual(['old']));
    expect(result.current.pending[0].categories).toEqual(['outside_folder']);
    rerender({ id: 'c2' });
    expect(result.current.pending).toEqual([]);
    expect(parsePending({ pending: [{ id: 'x', tool_name: 'Bash', categories: 'network' }] })[0].categories).toBeUndefined();
  });

  it('a failed answer rejects (the card shows it) and keeps the request', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react');
    const { usePendingPermissions } = await import('@/views/chat/permissions/use-pending-permissions');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/pending')
          ? ({ ok: true, status: 200, json: async () => ({ pending: [{ id: 'p1', tool_name: 'Write', input: {} }] }) } as Response)
          : ({ ok: false, status: 404, json: async () => ({ error: 'unknown request' }) } as Response),
      ),
    );
    const { result } = renderHook(() => usePendingPermissions('c1', 60_000));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await expect(result.current.answer('p1', 'allow')).rejects.toThrow('unknown request');
    expect(result.current.pending).toHaveLength(1);
  });
});
