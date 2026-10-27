/**
 * Model identity for marketplace offers and buyer requests. One canonical
 * form is applied at every boundary (offer publish, offer discovery, buyer
 * request, plan policy) so `model-mismatch` never depends on case,
 * surrounding whitespace, or Unicode composition.
 *
 * Model family inference ports the fork's known-family table
 * (`seller/model-ka.ts`). Logos and display assets are a UI-phase concern and
 * are not carried here.
 */

/** A canonical model id: lowercase, starts alphanumeric, at most 128 chars. */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:@+/-]{0,127}$/;

/** How the offer's model identity is backed. */
export type ModelProvenanceClass = 'weights-pinned' | 'upstream-claimed' | 'stub';

/**
 * Canonicalize a model id: `NFC → trim → lowercase`, valid iff the result
 * matches `MODEL_ID_PATTERN`. Non-string input (including `undefined` and
 * `null`, whose `String()` forms would otherwise pass the pattern) and
 * anything that does not match return `undefined`.
 */
export function canonicalModelId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const canonical = raw.normalize('NFC').trim().toLowerCase();
  return MODEL_ID_PATTERN.test(canonical) ? canonical : undefined;
}

/** The fork's known-family table, first match wins (order is part of the rule). */
const KNOWN_FAMILIES: ReadonlyArray<{ test: RegExp; family: string }> = [
  { test: /qwen/i, family: 'qwen' },
  { test: /gpt|codex|o[0-9]/i, family: 'openai' },
  { test: /deepseek/i, family: 'deepseek' },
  { test: /llama/i, family: 'meta' },
  { test: /mistral|mixtral/i, family: 'mistral' },
];

/** Infer a model family from a model id; `undefined` when no family matches. */
export function inferModelFamily(modelId: string): string | undefined {
  return KNOWN_FAMILIES.find((known) => known.test.test(modelId))?.family;
}
