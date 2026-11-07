/**
 * fix round: an open Modal must not add a second banner (or a contentinfo) landmark next to
 * the shell's top bar. axe flagged `landmark-no-duplicate-banner` / `landmark-unique` on `.fw-bar`
 * whenever a dialog was open, because the dialog's head was a `<header>` portalled into <body>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Modal } from '@/components/primitives';

afterEach(() => cleanup());

describe('Modal landmarks', () => {
  it('an open dialog leaves exactly one banner (the shell bar) and adds no contentinfo', () => {
    render(
      <>
        <header className="fw-bar">Werkplek</header>
        <Modal open onClose={() => undefined} title="Nieuw project" footer={<button type="button">Klaar</button>}>
          <p>Inhoud</p>
        </Modal>
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Nieuw project' })).toBeInTheDocument();
    const banners = screen.getAllByRole('banner');
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveClass('fw-bar');
    expect(screen.queryAllByRole('contentinfo')).toHaveLength(0);
  });

  it('the dialog head and foot keep their classes and the title stays the accessible name', () => {
    render(
      <Modal open onClose={() => undefined} title="Verwijderen" footer={<span>voet</span>}>
        <p>Inhoud</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Verwijderen' });
    expect(dialog.querySelector('.fw-modal__head h2')).toHaveTextContent('Verwijderen');
    expect(dialog.querySelector('.fw-modal__foot')).toHaveTextContent('voet');
  });
});
