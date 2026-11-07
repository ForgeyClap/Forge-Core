# React and Next.js accessibility patterns

Code-level patterns for the issues code review flags most: unlabelled fields, error text that is not
wired to its field, clickable divs, wrong ARIA, broken keyboard handling and lost focus. Native HTML
first, ARIA only for the gap (the hard rule in `SKILL.md`). Each pattern below says what to check in a
review; verify with a keyboard and a screen reader, not by reading the code alone.

Rewritten in Forge's words from ECC `frontend-a11y`; where the upstream sample had a defect it is
corrected here and the correction is named ("Fixed from upstream").

## Forms

**Label wiring.** Every `input`, `select` and `textarea` has a visible `<label htmlFor>` that matches
its `id` (or wraps it). In React, generate ids with `useId()` so two copies of a component never share
one.

```tsx
const id = useId();
<label htmlFor={id}>Email</label>
<input id={id} type="email" autoComplete="email" />
```

A placeholder is never the label: it disappears on typing and is often low contrast.

**Required fields.** Mark the field `required`; the browser exposes it to assistive tech, so
`aria-required` is only needed on custom (non-native) controls. Hide a decorative asterisk from screen
readers and explain it once at the top of the form ("Fields marked * are required").

```tsx
<label htmlFor={id}>Email <span aria-hidden="true">*</span></label>
<input id={id} type="email" required />
```

**Error wiring.** Tie the message to the field with `aria-describedby`, set `aria-invalid` only while
the error exists, and keep the message element in the DOM so the reference never points at nothing.
On submit, move focus to the first invalid field; announce a summary only when there are several.

```tsx
const errId = `${id}-error`;
<input id={id} type="email" required
  aria-invalid={error ? true : undefined}
  aria-describedby={error ? errId : undefined} />
<p id={errId} className="field-error">{error}</p>
```

Fixed from upstream: `role="alert"` on every inline error makes each keystroke re-announce while the
user types. Use it (or a polite live region) for a submit-time summary, not for every field; focus on
the first invalid field already reads its description.

**Autocomplete.** Personal fields carry the right `autoComplete` token (`email`, `name`, `tel`,
`current-password`, `new-password`, `street-address`); WCAG 1.3.5.

## Semantic elements

- An action is a `<button type="button">`; a destination is an `<a href>` (it supports new tab, copy
  link and middle click). In Next.js, `<Link href>` renders an anchor: never put `onClick` navigation
  on a div.
- A `<div onClick>` needs a role, `tabIndex={0}`, Enter and Space handling and a focus style to equal
  one `<button>`. Use the button.
- Headings go in order (`h1` then `h2`, never `h1` then `h4`); style is set with CSS, not by picking a
  smaller heading level.
- Lists of things are `<ul>`/`<ol>`; a Tailwind reset that removes list styling also removes the list
  role in Safari, so add `role="list"` back when the markers are hidden.

## Names and descriptions

- Icon-only button: `aria-label="Close dialog"` on the button, `aria-hidden="true"` on the SVG.
- A region with a visible heading: `aria-labelledby` pointing to that heading's id.
- Extra context that is not the name ("This cannot be undone"): `aria-describedby`.
- `aria-label` on a plain `div` or `span` with no role does nothing reliable: give it a role or use
  visible text.
- Decorative image: `alt=""` (that alone removes it; `aria-hidden` on top is redundant but harmless).
  Meaningful image: alt text that says what the image tells ("Revenue up 23 % from January to March"),
  not "chart".

## Live regions

- Polite status (saved, item added, 3 results): a container with `role="status"` that is already in
  the DOM before the message changes; React updates its text.
- Urgent error that must interrupt: `role="alert"`, sparingly.

Fixed from upstream: do not combine `role="status"` with `aria-live="assertive"`; the role already
implies polite, and the mix announces inconsistently. Pick the role that matches the urgency.

## Disclosure and accordion

```tsx
const panelId = useId();
<h3>
  <button type="button" aria-expanded={open} aria-controls={panelId}
    onClick={() => setOpen(o => !o)}>{title}</button>
</h3>
<div id={panelId} hidden={!open}>{children}</div>
```

The button sits inside the heading so heading navigation still finds the sections. Enter and Space work
because it is a real button.

## Select-only combobox (custom dropdown)

First ask whether a native `<select>` will do: it is accessible, works on touch and needs no code.
When a custom one is required, follow the WAI-ARIA Authoring Practices select-only combobox:

```tsx
function Picker({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(Math.max(0, options.indexOf(value)));
  const base = useId();
  const optId = (i) => `${base}-opt-${i}`;

  function onKeyDown(e) {
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(options[active]); setOpen(false); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }

  return (
    <>
      <span id={`${base}-label`}>{label}</span>
      <div role="combobox" tabIndex={0}
        aria-labelledby={`${base}-label`} aria-haspopup="listbox"
        aria-controls={`${base}-list`} aria-expanded={open}
        aria-activedescendant={open ? optId(active) : undefined}
        onKeyDown={onKeyDown} onClick={() => setOpen(o => !o)}
        onBlur={() => setOpen(false)}>
        {value}
      </div>
      <ul role="listbox" id={`${base}-list`} aria-labelledby={`${base}-label`} hidden={!open}>
        {options.map((o, i) => (
          <li key={o} id={optId(i)} role="option" aria-selected={o === value}
            className={i === active ? 'is-active' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onChange(o); setOpen(false); }}>{o}</li>
        ))}
      </ul>
    </>
  );
}
```

Fixed from upstream: the sample nested the listbox inside the combobox element, had no
`aria-activedescendant` and no option ids, so a screen reader could not follow the highlighted option;
it also showed the highlighted option as the value before anything was chosen. Here focus stays on the
combobox, the active option is referenced by id, `aria-selected` marks the chosen value, and the
listbox is a sibling. Check the visible highlight (`.is-active`) has 3:1 contrast. Type-ahead (jump
by first letter) is recommended for long lists. An editable combobox (with a text input) is a
different pattern; follow the Authoring Practices for it.

## Dialogs and focus restore

Prefer the native `<dialog>` opened with `showModal()`: modern browsers move focus in, keep Tab inside,
make the page behind inert, close on Escape and return focus to the opener.

```tsx
function Modal({ open, onClose, title, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>{title}</h2>
      {children}
      <button type="button" onClick={onClose}>Close</button>
    </dialog>
  );
}
```

When a custom overlay is unavoidable: save `document.activeElement` on open, move focus to the first
sensible control (or the dialog with `tabIndex={-1}`), keep Tab and Shift+Tab inside (a focus-trap
library is a dependency decision for Build Boss, not a default), set `inert` on the rest of the page,
close on Escape, and restore focus to the saved element on close. Fixed from upstream: its sample
restored focus inside an effect that also runs on first mount and had no trap; the native dialog avoids
both.

Route changes in a single-page app: move focus to the new page's `h1` (with `tabIndex={-1}`) or
announce the new title, so a screen-reader user knows the page changed.

## Reduced motion

CSS first: wrap non-essential motion in `@media (prefers-reduced-motion: no-preference)`, or turn it
off under `reduce`. Keep state changes visible (a plain fade or an instant change), never hide the
feedback.

When JavaScript drives the animation, read the preference once and follow changes:

```tsx
function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const on = (e) => setReduce(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}
```

It starts `false` on the server render, so pair it with the CSS media query to avoid a first-frame
animation for users who asked for less motion.

## Anti-patterns (each is a review finding)

| Pattern | Why it fails | Severity |
|---|---|---|
| `onClick` on a div or span with no role, tabIndex and key handling | not reachable or operable by keyboard (2.1.1) | Critical |
| placeholder as the only label | no programmatic name (1.3.1, 4.1.2) | Critical |
| `aria-hidden="true"` on a focusable element or its ancestor | keyboard focus lands on something the screen reader cannot see | Critical |
| positive `tabIndex` (1, 2, 3) | tab order no longer follows the page | Serious |
| `role="button"` without Enter and Space handling | announced as a button but does not act like one | Serious |
| `aria-label` on a role-less div | ignored by most screen readers | Moderate |
| `outline: none` without a replacement focus style | focus not visible (2.4.7) | Serious |
| colour alone shows the error or state | missed by colour-blind users (1.4.1) | Serious |

## Review checklist

- [ ] Every field has a visible, programmatic label; ids come from `useId()`.
- [ ] Errors are wired with `aria-describedby` and `aria-invalid`; focus moves to the first invalid field.
- [ ] No clickable div or span; actions are buttons, destinations are links.
- [ ] Icon-only buttons have an accessible name; decorative images have `alt=""`.
- [ ] Dialogs use `<dialog>` + `showModal()` or a real trap with inert background and focus restore.
- [ ] Custom widgets follow their Authoring Practices pattern (combobox, tabs, menu, accordion).
- [ ] Dynamic updates go through a live region that exists before the update.
- [ ] Reduced motion is honoured in CSS and, where needed, in JavaScript.
- [ ] An automated axe check in the test suite covers the component (`axe-and-tools.md`).
