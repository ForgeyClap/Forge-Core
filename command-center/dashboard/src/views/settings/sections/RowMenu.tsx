/**
 * RowMenu — the `...` menu of an account row (DESIGN.md §3.4: Testen, Inloggen/Uitloggen, Over dit account).
 *
 * The same keyboard and focus rules as the shell's menus: opening moves focus to the first item that can
 * be used; Up/Down/Home/End move; Escape closes and gives focus back to the button; Tab out or a click
 * elsewhere closes without pulling focus back. An item that cannot be used yet stays in the list, greyed
 * (aria-disabled), with its reason on the line under it and tied to it by aria-describedby.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icon } from '@/components/primitives';

export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** Greyed with this reason under it; selecting does nothing. */
  readonly disabledReason?: string;
  /** Marks a toggle that is open now (Inloggen, Over dit account). */
  readonly expanded?: boolean;
  readonly onSelect: () => void;
}

export interface RowMenuProps {
  /** The button's accessible name, e.g. "Acties voor Claude". */
  readonly label: string;
  readonly items: readonly RowMenuItem[];
}

export function RowMenu({ label, items }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const reasonBase = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index]?.focus();
  }, [open, index]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (!menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  function firstUsable(): number {
    const found = items.findIndex((item) => !item.disabledReason);
    return found < 0 ? 0 : found;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const last = items.length - 1;
    let next = -1;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown') next = index >= last ? 0 : index + 1;
    else if (event.key === 'ArrowUp') next = index <= 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next < 0) return;
    event.preventDefault();
    setIndex(next);
  }

  return (
    <span className="fs-rowmenu">
      <button
        ref={triggerRef}
        type="button"
        className="fw-control fw-icon-button fw-icon-button--sm fs-rowmenu__btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setIndex(firstUsable());
          setOpen((value) => !value);
        }}
      >
        <Icon name="Ellipsis" size="sm" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="fs-rowmenu__pop"
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) close(false);
          }}
        >
          {items.map((item, position) => {
            const reasonId = item.disabledReason ? `${reasonBase}-${position}` : undefined;
            return (
              <div key={item.id} className="fs-rowmenu__entry" role="none">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="fs-rowmenu__item"
                  aria-disabled={item.disabledReason ? true : undefined}
                  aria-describedby={reasonId}
                  aria-expanded={item.expanded}
                  onClick={() => {
                    if (item.disabledReason) return;
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size="sm" className="fs-rowmenu__icon" /> : null}
                  <span>{item.label}</span>
                </button>
                {item.disabledReason ? (
                  <span className="fs-rowmenu__reason" id={reasonId}>
                    {item.disabledReason}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
