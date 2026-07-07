/**
 * Issue #1464 (PR1, diagnostic) — NAME the WM→SWM promote step that threw.
 *
 * The intermittent "root never lands in SWM" failure is masked: a pre-insert
 * awaited op in `assertionPromote` (a `resolveKaNumber` / `assertionScopedQuads`
 * SPARQL read, etc.) can reject — e.g. the 30s `AbortSignal.timeout` on the
 * sparql-http read fires under load — and the raw transport error surfaces in
 * the UI banner with no hint about WHICH step failed. That makes the recurrence
 * look like a silent migration gap rather than a named, actionable throw.
 *
 * `tagPromoteStep` wraps one awaited op so a rejection is re-surfaced as
 * `"[promote:<step>] <original message>"`. It is DIAGNOSTIC ONLY: it never
 * swallows, retries, or alters control flow — it rethrows the SAME failure with
 * a step label, then lets it propagate exactly as before.
 *
 * Identity preservation: the tag is applied by mutating the caught error's
 * `message` in place, so the original stack, `name`, typed-error class
 * (`instanceof`), and `code` all survive — the last matters because PR2's
 * transient-vs-deterministic classification keys on `err.code`/`err.name`.
 * `DOMException` (what `AbortSignal.timeout` throws) has a read-only `message`;
 * when the in-place mutation is refused we wrap instead, carrying the `cause`,
 * `name`, and `code` forward. On that wrap path the original stack + the
 * `instanceof DOMException` identity survive only via `err.cause` (the new
 * Error gets its own top-frame stack) — no downstream matcher depends on either.
 */

const PROMOTE_STEP_TAG_PREFIX = '[promote:';

/**
 * Return `err` re-labelled with the promote step that produced it. Idempotent:
 * an error already carrying a `[promote:…]` prefix (the innermost, most specific
 * step) is returned untouched, so nesting a tagged op inside another tagged op
 * keeps the deepest label rather than stacking prefixes.
 */
export function tagPromoteError(step: string, err: unknown): unknown {
  const prefix = `[promote:${step}]`;
  if (err !== null && typeof err === 'object') {
    const e = err as { message?: unknown; name?: unknown; code?: unknown };
    if (typeof e.message === 'string') {
      const original = e.message;
      // Innermost tag wins — never double-prefix.
      if (original.startsWith(PROMOTE_STEP_TAG_PREFIX)) return err;
      const tagged = `${prefix} ${original}`;
      // Prefer in-place mutation (preserves stack / name / class / code).
      try {
        (e as { message: string }).message = tagged;
      } catch {
        /* read-only message (e.g. DOMException) — handled by the check below */
      }
      // Verify the mutation stuck (a read-only setter may throw in strict mode
      // OR silently no-op in sloppy mode); wrap only if it did not.
      if (e.message === tagged) return err;
      const wrapped = new Error(tagged, { cause: err });
      if (typeof e.name === 'string') wrapped.name = e.name;
      if (e.code !== undefined) (wrapped as { code?: unknown }).code = e.code;
      return wrapped;
    }
  }
  return new Error(`${prefix} ${String(err)}`);
}

/**
 * Run one awaited promote op, re-labelling any rejection with `step` via
 * {@link tagPromoteError}. Resolved values pass through unchanged. The `op` is
 * a thunk so it is invoked inside the try — a synchronous throw is tagged too.
 */
export async function tagPromoteStep<T>(step: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw tagPromoteError(step, err);
  }
}
