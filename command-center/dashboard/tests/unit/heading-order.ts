/**
 * fix round: the axe `heading-order` rule in a unit test. Returns every heading skip inside
 * `root` (h1-h6 and role="heading" with aria-level, in document order): a heading may go deeper by at
 * most one level after the previous one. An empty list means the outline is sequential.
 */
export function headingSkips(root: ParentNode): string[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]'));
  const skips: string[] = [];
  let previous: number | null = null;
  for (const node of nodes) {
    const level = /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : Number(node.getAttribute('aria-level') ?? 2);
    if (previous !== null && level > previous + 1) skips.push(`h${previous} -> h${level} "${(node.textContent ?? '').trim()}"`);
    previous = level;
  }
  return skips;
}
