/**
 * Disclosure — the "Meer info" control (DESIGN.md §6).
 *
 * A quiet text button with a chevron that expands its content in place. It remembers
 * nothing: every mount starts closed unless `defaultOpen` says otherwise. The trigger is a
 * real <button> with aria-expanded and aria-controls, so Enter and Space work natively and
 * a screen reader hears the state. The region stays in the DOM with the `hidden`
 * attribute (and an explicit [hidden] rule, so no display value can override it).
 *
 * The label is a prop on purpose: views pass the locale string (rd.* keys from part 1D).
 */

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface DisclosureProps {
  /** The trigger text, e.g. t('rd.common.moreInfo') -> "Meer info". */
  label: ReactNode;
  /** Trigger text while open. Defaults to `label`. */
  openLabel?: ReactNode;
  defaultOpen?: boolean;
  /** Called after the state changes. */
  onToggle?: (open: boolean) => void;
  className?: string;
  children?: ReactNode;
}

export function Disclosure({ label, openLabel, defaultOpen = false, onToggle, className, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  const classes = ['fw-disclosure'];
  if (open) classes.push('is-open');
  if (className) classes.push(className);

  function toggle() {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  }

  return (
    <div className={classes.join(' ')}>
      <button
        type="button"
        className="fw-disclosure__trigger"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
      >
        <span>{open && openLabel != null ? openLabel : label}</span>
        <Icon name="ChevronDown" size="sm" className="fw-disclosure__chevron" />
      </button>
      <div id={regionId} className="fw-disclosure__panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
