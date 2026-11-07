# forge-a11y — Keyboard, focus, contrast, zoom, motion

## Keyboard pass (no mouse)
- Tab and Shift+Tab reach every interactive element, in an order that follows the visual reading order.
- Enter activates links and buttons; Space activates buttons and toggles checkboxes; arrow keys move inside
  composite widgets (tabs, menus, radio groups, listboxes); Escape closes dialogs, menus and popovers.
- A skip link ("Skip to main content") is the first focusable element on pages with repeated navigation.
- No keyboard trap: focus can always leave a component (except a modal, which traps on purpose until closed).
- Custom controls built from `div`/`span` need a role, `tabindex="0"` and key handlers; prefer native elements.
- Positive `tabindex` values (1, 2, ...) are almost always a bug.

## Focus management
- Visible focus indicator on every focusable element, contrast at least 3:1 against its surroundings;
  use `:focus-visible` rather than removing outlines.
- Opening a modal moves focus into it; closing returns focus to the element that opened it.
- In single-page apps, route changes move focus to the new page heading (or announce the change) and update
  the document title.
- After deleting an item or closing a panel, focus lands somewhere sensible, never on `<body>`.
- Sticky headers, cookie banners and chat bubbles do not cover the focused element (WCAG 2.2 2.4.11).

## Contrast
- Normal text 4.5:1; large text (24 px regular or 18.66 px bold and up) 3:1.
- UI component boundaries, icons that carry meaning and focus indicators 3:1 against adjacent colours.
- Check every state: hover, focus, disabled (disabled is exempt but still check it is recognisable),
  placeholder text, text over images and gradients.
- Never carry meaning by colour alone: errors get an icon or text, links in body text get an underline.

## Zoom, reflow, spacing
- 200% browser zoom: no loss of content or function.
- Reflow at 320 CSS px wide (400% zoom on 1280): no horizontal scrolling for text content.
- Text spacing override (line height 1.5, paragraph 2x, letter 0.12em, word 0.16em) does not clip text.
- Never `user-scalable=no` or `maximum-scale=1` in the viewport meta.

## Motion and media
- Respect `prefers-reduced-motion`: turn off parallax, large transitions and autoplaying animation.
- Anything that moves, blinks or auto-updates for more than 5 seconds can be paused.
- No content flashes more than three times per second.
- Video has captions; audio-only content has a transcript.

## Targets
- Pointer targets at least 24x24 CSS px or well spaced (2.5.8); 44x44 is the comfortable mobile size.
- Drag interactions have a click/tap alternative (2.5.7).
