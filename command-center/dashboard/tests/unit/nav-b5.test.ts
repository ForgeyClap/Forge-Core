/**
 * WP B5 — the three new Uitgebreid destinations (plan §4.2): visible in Uitgebreid only, never in
 * Eenvoudig, each with a Dutch label from the glossary; /tests no longer shares the "Klussen &
 * bewijs" label with /jobs.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { ALL_NAV, navVisibility, primaryNavFor, secondaryNavFor, sidebarSectionsFor } from '@/components/shell/nav-config';

describe('nav: WP B5 screens', () => {
  beforeEach(() => setLocale('nl'));

  it('/jobs, /automations and /skills are Uitgebreid-only', () => {
    for (const path of ['/jobs', '/automations', '/skills']) {
      expect(navVisibility(path)).toBe('advanced');
      expect(primaryNavFor('eenvoudig').map((item) => item.path)).not.toContain(path);
      expect([...primaryNavFor('uitgebreid'), ...secondaryNavFor('uitgebreid')].map((item) => item.path)).toContain(path);
    }
  });

  it('Eenvoudig keeps exactly its four entries', () => {
    expect(primaryNavFor('eenvoudig').map((item) => item.path)).toEqual(['/', '/projects', '/chat', '/settings']);
  });

  // Redesign 1C (DESIGN.md §2): the sidebar shows five Eenvoudig entries: three on top, Leer Forge and
  // Instellingen in the foot. Uitgebreid adds its screens in a separate group, never in the foot.
  it('the redesigned sidebar: Start, Mijn projecten, Gesprekken on top, Leer Forge and Instellingen in the foot', () => {
    const simple = sidebarSectionsFor('eenvoudig');
    expect(simple.main.map((item) => item.path)).toEqual(['/', '/projects', '/chat']);
    expect(simple.advanced).toEqual([]);
    expect(simple.foot.map((item) => item.path)).toEqual(['/learn', '/settings']);
    expect([...simple.main, ...simple.foot]).toHaveLength(5);
    expect(simple.foot[0].label).toBe('Leer Forge');

    const advanced = sidebarSectionsFor('uitgebreid');
    expect(advanced.main.map((item) => item.path)).toEqual(['/', '/projects', '/chat']);
    expect(advanced.foot.map((item) => item.path)).toEqual(['/learn', '/settings']);
    const advancedPaths = advanced.advanced.map((item) => item.path);
    for (const path of ['/team', '/jobs', '/automations', '/skills', '/mission', '/tasks', '/artifacts', '/tests', '/activity', '/discord']) {
      expect(advancedPaths).toContain(path);
    }
    expect(advancedPaths).not.toContain('/settings');
    expect(navVisibility('/learn')).toBe('always');
  });

  it('labels are the glossary words and no two entries share a label', () => {
    const label = (path: string) => ALL_NAV.find((item) => item.path === path)?.label;
    expect(label('/jobs')).toBe('Klussen & bewijs');
    expect(label('/automations')).toBe('Automatiseringen');
    // the nav label fits the 232px rail; the page title keeps the full name.
    expect(label('/skills')).toBe('Vaardigheden');
    // "Overzicht" sounded like Projectoverzicht and Mijn projecten; the run graph is the Klusverloop.
    expect(label('/mission')).toBe('Klusverloop');
    expect(label('/tests')).toBe('Controles');
    const visible = [...primaryNavFor('uitgebreid'), ...secondaryNavFor('uitgebreid')].map((item) => item.label);
    expect(new Set(visible).size).toBe(visible.length);
  });

  it('Vaardigheden uses a blocks icon, never a sparkle or star (BRAND.md: no sparkle for AI)', () => {
    const icon = ALL_NAV.find((item) => item.path === '/skills')?.icon;
    expect(icon).toBe('Blocks');
    for (const item of ALL_NAV) expect(item.icon).not.toMatch(/Sparkle|Star/);
  });
});
