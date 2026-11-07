/**
 * ShellMenu — the bar's two small menus (`?` and `...`, DESIGN.md §2): an icon button that opens a list
 * of actions under it.
 *
 * Keyboard and focus follow the rules the old account menu proved (D4/D5): opening moves
 * focus to the first item; Escape closes and gives focus back to the button; focus leaving the menu (Tab
 * out, a click elsewhere) closes it without pulling focus back; a click on the button while open closes
 * it. Up/Down/Home/End move between items.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icon } from '@/components/primitives';


export interface ShellMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** Optional trailing hint, e.g. a key chord. */
  readonly hint?: string;
  readonly onSelect: () => void;
}

export interface ShellMenuProps {
  /** The button's accessible name; the menu carries the same name. */
  readonly label: string;
  readonly icon: string;
  readonly items: readonly ShellMenuItem[];
  /** A tour anchor on the button (`data-tour`). */
  readonly tourAnchor?: string;
}

export function ShellMenu({ label, icon, items, tourAnchor }: ShellMenuProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

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
      // The button's own click toggles; closing here too would reopen it right after.
      if (triggerRef.current?.contains(target)) return;
      if (!menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const last = items.length - 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((i) => (i >= last ? 0 : i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((i) => (i <= 0 ? last : i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setIndex(last);
    }
  }

  return (
    <span className="fw-bar__menu">
      <button
        ref={triggerRef}
        type="button"
        className="fw-bar__icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tour={tourAnchor}
        onClick={() => {
          setIndex(0);
          setOpen((value) => !value);
        }}
      >
        <Icon name={icon} size="md" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="fw-bar__popover"
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) close(false);
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="fw-bar__item"
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} size="sm" className="fw-bar__item-icon" /> : null}
              <span className="fw-bar__item-label">{item.label}</span>
              {item.hint ? <span className="fw-bar__item-hint">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
