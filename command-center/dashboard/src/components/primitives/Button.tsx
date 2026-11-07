/**
 * Button — Forge Systeem v1.0 (BRAND.md > Buttons and states).
 *
 *   primary    the one Pauw action on a screen
 *   secondary  surface with the field-edge border (`ghost` is the same look, kept for old callers)
 *   quiet      text only, an Inleg wash on hover
 *   danger     Gloei text on a surface; the border turns Gloei on hover
 *
 * 40 px by default, 32 px for `sm` (compact density in Uitgebreid uses its own values).
 * Labels are verbs that say what happens; no arrow is appended to the text.
 *
 * `loading` keeps the label and the width, puts a 16 px spinner where the icon was and
 * marks the button aria-busy. It does not disable the button by itself.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** lucide icon name shown before the label. */
  icon?: string;
  /** lucide icon name shown after the label. */
  iconRight?: string;
  /** Stretch to the width of the container. */
  block?: boolean;
  /** Working inside this action: spinner in place of the icon, same label, same width. */
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  iconRight,
  block = false,
  loading = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = ['fw-control', 'fw-button', `fw-button--${variant}`, `fw-button--${size}`];
  if (block) classes.push('fw-button--block');
  if (className) classes.push(className);

  const iconSize = size === 'sm' ? 'xs' : 'sm';
  const leading = loading ? 'Loader' : icon;

  return (
    <button {...rest} type={type} className={classes.join(' ')} aria-busy={loading ? true : rest['aria-busy']}>
      {leading ? <Icon name={leading} size={iconSize} spin={loading} className="fw-button__icon" /> : null}
      {children != null ? <span className="fw-button__label">{children}</span> : null}
      {iconRight && !loading ? <Icon name={iconRight} size={iconSize} className="fw-button__icon" /> : null}
    </button>
  );
}
