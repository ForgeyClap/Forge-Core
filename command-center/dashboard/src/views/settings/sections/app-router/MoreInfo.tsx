/**
 * MoreInfo — the router's "Meer info" control (DESIGN.md §6), controlled by its parent.
 *
 * Same markup and classes as the `Disclosure` primitive (a quiet text button with a chevron, the region kept
 * in the page with `hidden`), but the parent owns `open`: the router opens it by itself when a field inside has
 * an error, so a problem is never hidden behind a closed toggle. The content mounts only while open, so the
 * control remembers nothing (§6) and closed content is not in the page at all.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

export interface MoreInfoProps {
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function MoreInfo({ open, onToggle, className, children }: MoreInfoProps) {
  const { t } = useLocale();
  const regionId = useId();
  const classes = ['fw-disclosure'];
  if (open) classes.push('is-open');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')}>
      <button type="button" className="fw-disclosure__trigger" aria-expanded={open} aria-controls={regionId} onClick={() => onToggle(!open)}>
        <span>{open ? t('rd.settings.lessInfo') : t('rd.settings.moreInfo')}</span>
        <Icon name="ChevronDown" size="sm" className="fw-disclosure__chevron" />
      </button>
      <div id={regionId} className="fw-disclosure__panel" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
