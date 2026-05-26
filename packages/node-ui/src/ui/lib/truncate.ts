/**
 * Middle-ellipsis truncation for chip-sized strings. Originally added
 * for the #706 sub-graph chip (slugs are commonly prefix-namespaced
 * — `epcis-*`, `github-*` — so the discriminator lives at the end;
 * mid-truncation preserves both sides and keeps the chip compact).
 * Lives in `lib/` so both `AssertionsList` (components.tsx) and the
 * `MemoryLayerView` AssertionList row can render the same chip
 * without either consumer reaching across views.
 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  // Reserve 1 char for the ellipsis; split the remaining budget
  // weighted slightly toward the prefix (so namespace prefixes
  // like `epcis-` survive in full on common slug widths).
  const budget = max - 1;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
