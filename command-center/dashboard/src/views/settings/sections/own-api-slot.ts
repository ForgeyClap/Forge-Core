/**
 * own-api-slot — where the Eigen API list is drawn on the Settings page (DESIGN.md §3.4: its own group in
 * Uitgebreid, right after Accounts; fix round XR-SET).
 *
 * The list shares the provider list, the key vault list and the "saved elsewhere" counter with Je accounts (an
 * entry saved through "Account toevoegen" shows up in both places), so AccountsSection keeps rendering it and
 * only its place in the page moves: SettingsView hands over the body element of the Eigen API group through this
 * context, and AccountsSection portals the list into it. DOM order then follows the visual order (DESIGN.md §7).
 */

import { createContext, useContext } from 'react';

/**
 * `undefined`: no Settings page around it (a section rendered on its own): the list stays inline.
 * `null`: the page has not mounted the Eigen API group (Eenvoudig, or the first render): nothing is drawn.
 */
export const OwnApiSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export function useOwnApiSlot(): HTMLElement | null | undefined {
  return useContext(OwnApiSlotContext);
}
