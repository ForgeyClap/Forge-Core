# forge-a11y — Screen-reader testing

## Which pairings
| Priority | Pairing | Platform |
|---|---|---|
| Minimum | NVDA + Firefox or Chrome | Windows |
| Minimum | VoiceOver + Safari | macOS |
| Minimum | VoiceOver + Safari | iOS |
| Broader | JAWS + Chrome | Windows |
| Broader | TalkBack + Chrome | Android |
| Broader | Narrator + Edge | Windows |

Say which pairings were really used. When no screen reader is available in the environment (for example a
headless agent run), inspect the accessibility tree instead (Playwright `page.accessibility` snapshot or
`ariaSnapshot()`, DevTools Accessibility pane) and list the screen-reader pass as NOT RUN, an owner/manual step.

## Modes to understand
- **Browse / virtual mode:** reading content with arrow keys and quick-nav keys (headings, landmarks, links).
- **Focus / forms mode:** typing into fields and operating controls; switches automatically on most fields.
- **Application mode:** custom widgets with `role="application"` take all keys; avoid it unless needed.

## What to listen for
- Each control announces a name, a role and its state ("Remember me, checkbox, not checked").
- Headings and landmarks give a usable outline; the heading list alone tells you what the page is.
- Images: informative ones have meaningful alt text; decorative ones are silent (`alt=""`).
- Links and buttons make sense out of context ("Download invoice 42 (PDF)", not "Click here").
- Form errors are announced when they appear and linked to the field (`aria-describedby`), with the fix.

## Widget patterns to verify
- **Modal dialog:** `role="dialog"` (or native `<dialog>`), `aria-modal="true"`, labelled by its heading;
  focus moves in, stays in while open, Escape closes, focus returns to the trigger; background is inert.
- **Live regions:** `role="status"` (polite) for saved/added messages, `role="alert"` (assertive) for urgent
  errors, `role="log"` for appended feeds. The region must exist in the DOM before its text changes.
- **Tabs:** `tablist` / `tab` / `tabpanel`, `aria-selected`, `aria-controls`; arrow keys move between tabs,
  Home/End jump to first/last.
- **Disclosure / accordion:** a button with `aria-expanded` that toggles the controlled region.
- **Progress:** `role="progressbar"` with `aria-valuenow`/`min`/`max` and a label.
- **Comboboxes and menus:** follow the WAI-ARIA Authoring Practices pattern exactly or use a well-tested
  library; half-implemented ARIA widgets are a frequent Critical.

## Do and do not
- Do test keyboard-only first, then the screen reader; test both browse and focus modes; test error and empty
  states and dynamic content, not only the happy path; test mobile.
- Do not rely on one screen reader, on visual inspection alone, or on an automated score.
