/**
 * ChoiceList — radio option cards (DESIGN.md §3.4 router, §3.5 onboarding step 2, the
 * "Account toevoegen" dialog).
 *
 * Each option is a card with a radio ring, an optional letter or icon tile, a name and one
 * sub-line. The chosen card turns Pauwnevel with a Pauw edge. Real radiogroup semantics:
 * roving tabindex, arrow keys move and select, Home/End jump to the ends, Space and Enter
 * select (native button click).
 *
 * `describe="selected"` shows the sub-line only under the chosen option (the Uitgebreid
 * router: "Only the chosen option shows its one-line explanation").
 *
 * Third-party names (Claude, ChatGPT) get a neutral letter tile in our colours, never
 * their logo.
 */

import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon';

export interface ChoiceOption {
  value: string;
  title: ReactNode;
  /** One short line. */
  description?: ReactNode;
  /** A single letter for the tile, e.g. "C". */
  letter?: string;
  /** A lucide icon name for the tile (used when there is no letter). */
  icon?: string;
  /** Something at the end of the row, e.g. a StatusBadge. */
  aside?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceListProps {
  options: readonly ChoiceOption[];
  /** The chosen value, or '' / null for nothing chosen yet. */
  value: string | null;
  onChange: (value: string) => void;
  /** Accessible name of the group. Required. */
  label: string;
  /** Show the description under every option (default) or only under the chosen one. */
  describe?: 'all' | 'selected';
  className?: string;
}

export function ChoiceList({ options, value, onChange, label, describe = 'all', className }: ChoiceListProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const enabled = options.filter((option) => !option.disabled);
  const selectedIndex = options.findIndex((option) => option.value === value);
  // Roving tabindex: the chosen option, or the first enabled one when nothing is chosen.
  const tabStop = selectedIndex >= 0 && !options[selectedIndex].disabled ? options[selectedIndex].value : enabled[0]?.value;

  function focusValue(next: string) {
    const nodes = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    nodes?.forEach((node) => {
      if (node.dataset.value === next) node.focus();
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === (event.target as HTMLElement).dataset?.value);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % enabled.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(enabled[next].value);
    focusValue(enabled[next].value);
  }

  const classes = ['fw-choices'];
  if (className) classes.push(className);

  return (
    <div ref={groupRef} className={classes.join(' ')} role="radiogroup" aria-label={label} onKeyDown={handleKeyDown}>
      {options.map((option) => {
        const selected = option.value === value;
        const hasTile = option.letter != null || option.icon != null;
        const showDescription = option.description != null && (describe === 'all' || selected);
        const optionClasses = ['fw-choice'];
        if (hasTile) optionClasses.push('fw-choice--tile');
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            tabIndex={option.value === tabStop ? 0 : -1}
            data-value={option.value}
            className={optionClasses.join(' ')}
            onClick={() => onChange(option.value)}
          >
            <span className="fw-choice__radio" aria-hidden="true" />
            {hasTile ? (
              <span className="fw-choice__tile" aria-hidden="true">
                {option.letter != null ? option.letter : <Icon name={option.icon as string} size="md" />}
              </span>
            ) : null}
            <span className="fw-choice__name">{option.title}</span>
            {option.aside != null ? <span className="fw-choice__aside">{option.aside}</span> : null}
            {showDescription ? <span className="fw-choice__sub">{option.description}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
