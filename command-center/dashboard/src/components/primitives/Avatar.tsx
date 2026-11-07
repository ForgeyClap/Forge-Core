/**
 * Avatar — a neutral letter tile (Inleg fill, struck-style corner). No photographs, no
 * generated faces, no third-party logos or colours.
 *
 * `group` is still accepted and written to data-group for old callers, but the seven
 * agent-group metal colours are gone (DESIGN.md §3.7): every tile looks the same.
 */

import type { AgentGroup } from '@/prototype/types/prototype-types';

export interface AvatarProps {
  name: string;
  size?: 'sm' | 'md';
  /** Kept for old callers; no longer changes the look. */
  group?: AgentGroup;
  /** Set when the name is already rendered next to the avatar. */
  decorative?: boolean;
  className?: string;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, size = 'md', group, decorative = false, className }: AvatarProps) {
  const classes = ['fw-avatar', `fw-avatar--${size}`];
  if (className) classes.push(className);

  return (
    <span
      className={classes.join(' ')}
      data-group={group}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      title={name}
    >
      <span aria-hidden="true">{initialsFor(name)}</span>
    </span>
  );
}
