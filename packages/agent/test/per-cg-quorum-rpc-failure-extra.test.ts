/**
 * PR #229 bot review (r31-4 — packages/agent/src/dkg-agent.ts:2701).
 *
 * The pre-r31-4 implementation wrapped BOTH the `BigInt(onChainId)`
 * parse AND the chain-RPC call to `getContextGraphRequiredSignatures()`
 * in a single catch block:
 *
 *   try {
 *     const id = BigInt(onChainId);
 *     if (id > 0n) {
 *       const n = await this.chain.getContextGraphRequiredSignatures(id);
 *       if (Number.isFinite(n) && n > 0) perCgRequiredSignatures = n;
 *     }
 *   } catch {
 *     // non-numeric on-chain id (mock-only graph) → skip per-CG gate.
 *   }
 *
 * The catch block was supposed to swallow the legitimate "mock-only
 * graph has a non-numeric id" case (the BigInt parse throws a
 * `SyntaxError`). But because the await on the RPC call lives inside
 * the same try, ANY transient chain-RPC failure (provider timeout,
 * contract revert, RPC node 502) was also swallowed silently — and
 * `perCgRequiredSignatures` quietly stayed `undefined`. The publish
 * path then fell back to the global `ParametersStorage.minimumRequiredSignatures`
 * and could confirm an M-of-N context graph with too few ACKs. That
 * is the EXACT regression r26-1 was supposed to prevent.
 *
 * The r31-4 fix splits the two failure modes:
 *   (a) BigInt parse failure → mock-only on-chain id, skip the gate;
 *   (b) RPC / contract failure → propagate so the publish fails
 *       loudly instead of silently downgrading the quorum.
 *
 * These tests pin the contract structurally so a future "tidy the
 * catch back together" change reintroduces the regression visibly:
 *   1. Source-level: `dkg-agent.ts` must NOT contain a try/catch
 *      that wraps both the `BigInt(onChainId)` parse AND the
 *      `await this.chain.getContextGraphRequiredSignatures(...)`
 *      RPC call.
 *   2. Source-level: the RPC call MUST live OUTSIDE the catch block,
 *      so RPC errors propagate to the caller.
 *   3. Both call sites (the `_publish()` direct path AND the
 *      `publishFromSharedMemory()` SWM path) get the same treatment.
 *
 * No chain spin-up is needed — these are structural anti-drift
 * guards that read the source file directly. Behavioural coverage
 * for the per-CG quorum gate itself lives in
 * `per-cg-quorum-extra.test.ts` (real chain, real publisher) and is
 * the source of truth for the "tentative vs confirmed" outcome.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dkgAgentPath = resolve(here, '..', 'src', 'dkg-agent.ts');
const src = readFileSync(dkgAgentPath, 'utf-8');

describe('[r31-4] per-CG `requiredSignatures` resolution: chain-RPC errors must propagate (NOT be silently swallowed by the BigInt-parse catch)', () => {
  it('the catch block must NOT wrap the `await this.chain.getContextGraphRequiredSignatures(...)` RPC call (regression guard for the r26-1 swallow-all)', () => {
    // The legacy shape used `const id = BigInt(onChainId)` and then
    // `await this.chain.getContextGraphRequiredSignatures(id)` ALL
    // inside the same `try { ... } catch` block. The r31-4 fix
    // renames the parsed value to `candidate` and moves the await
    // OUTSIDE the catch (gated on a separate `parsedId !== null`
    // check). So if we find `const id = BigInt(onChainId)` paired
    // with the RPC await before a `} catch` closer, the legacy
    // catch-all has been reintroduced.
    //
    // We split this into two halves to avoid spurious matches across
    // unrelated parts of the 7000+-line source file:
    //   1. The legacy variable name (`const id = BigInt(...)`) must
    //      NOT appear in the source — every occurrence MUST use the
    //      new `const candidate = ...` shape.
    //   2. The legacy await-inside-catch shape (where the BigInt
    //      throw and the RPC throw are both swallowed) must be
    //      absent.
    expect(src).not.toMatch(/const\s+id\s*=\s*BigInt\(onChainId\)/);
    // The full legacy try-shape: `try { const id = BigInt(...); if (id > 0n) { const n = await this.chain.getContextGraphRequiredSignatures(id); ... } } catch`.
    const legacyPattern =
      /try\s*\{[\s\S]{0,400}?const\s+id\s*=\s*BigInt\(onChainId\)[\s\S]{0,400}?await\s+this\.chain\.getContextGraphRequiredSignatures\(id\)[\s\S]{0,400}?\}\s*catch/;
    expect(src).not.toMatch(legacyPattern);
  });

  it('the BigInt parse of `onChainId` MUST live in its own try/catch (the legitimate mock-only-graph escape hatch)', () => {
    // The fix preserves the legitimate "non-numeric on-chain id" path
    // by giving `BigInt(onChainId)` its own narrow try/catch. The
    // catch body sets `parsedId = null` and falls through. If a
    // future refactor drops this guard, the BigInt(non-numeric)
    // throw would propagate up and break the legitimate mock-only
    // graph path.
    //
    // We pin the new shape: a try block whose body is JUST the
    // BigInt parse + a guard, paired with a catch that resets
    // the parsed id.
    expect(src).toMatch(/try\s*\{\s*const\s+candidate\s*=\s*BigInt\(onChainId\)/);
    // And the catch must reset the parsed id so we know the BigInt
    // throw is the only thing we ever swallow.
    expect(src).toMatch(/parsedId\s*=\s*null/);
  });

  it('the chain-RPC call MUST live OUTSIDE every catch block (errors propagate)', () => {
    // Find each `await this.chain.getContextGraphRequiredSignatures(`
    // call site and verify that the immediately enclosing block is
    // NOT a try block that swallows errors. We can do this lexically
    // by checking that, looking BACKWARD from the call site, we see
    // a `if (parsedId !== null)` guard before we see any `try {`.
    // That ordering is the structural property the r31-4 split
    // preserves.
    const occurrences = [
      ...src.matchAll(/await\s+this\.chain\.getContextGraphRequiredSignatures\(/g),
    ];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // _publish + publishFromSharedMemory

    for (const m of occurrences) {
      const idx = m.index ?? 0;
      // Find the most recent `if (parsedId !== null)` BEFORE the call.
      const prefix = src.slice(0, idx);
      const lastIfIdx = prefix.lastIndexOf('if (parsedId !== null)');
      const lastTryIdx = prefix.lastIndexOf('try {');
      // The `if (parsedId !== null)` MUST be more recent than the
      // last `try {` — i.e. the call is gated by the parsed-id check
      // and is OUTSIDE the BigInt-parse try.
      expect(
        lastIfIdx,
        `await getContextGraphRequiredSignatures at offset ${idx} must be guarded by 'if (parsedId !== null)' (not wrapped in a swallowing catch)`,
      ).toBeGreaterThan(lastTryIdx);
    }
  });

  it('both publish call sites (`_publish` direct path AND `publishFromSharedMemory` SWM path) get the r31-4 split — anti-drift across BOTH paths', () => {
    // The bot explicitly noted "the same pattern appears in the
    // shared-memory publish path below". The fix MUST land in both
    // spots — otherwise an SWM publish could still silently downgrade
    // the quorum even though the direct publish does not.
    //
    // Both paths now use the `parsedId` discriminator (the new shape
    // post-r31-4), so we count the discriminator occurrences. Two
    // sites = both paths fixed; <2 means one path drifted back to
    // the legacy catch-all.
    const parsedIdGates = src.match(/if\s*\(\s*parsedId\s*!==\s*null\s*\)/g) ?? [];
    expect(parsedIdGates.length).toBeGreaterThanOrEqual(2);

    // Both r31-4 fix-comment markers must be present (one per path).
    const r314Markers = src.match(/r31-4\s+—\s+dkg-agent\.ts:2701/g) ?? [];
    expect(r314Markers.length).toBeGreaterThanOrEqual(2);
  });

  it('no `catch` block in the per-CG-quorum resolution swallows ALL errors silently (each catch must have a narrow purpose)', () => {
    // Negative pin: the legacy `} catch {` (empty discriminator)
    // wrapping the RPC await is gone. The only remaining catch in
    // the per-CG-quorum block is the BigInt-parse one, and its
    // body assigns `parsedId = null` rather than being empty.
    //
    // Find the line range that contains the per-CG-quorum resolution
    // (between the two r26-1/r31-4 comment markers and the next
    // `await this.publisher.publish` / `await this.publisher.publishFromSharedMemory`)
    // and assert no empty `} catch {` block lives within it that
    // wraps an RPC await.
    //
    // Scoping is approximate but tight enough to catch the regression:
    // we look at the chunks between each `BigInt(onChainId)` and the
    // next `await this.publisher` and verify they don't contain the
    // legacy empty-catch shape paired with the RPC call.
    const segments = [
      ...src.matchAll(
        /BigInt\(onChainId\)[\s\S]{0,3000}?await\s+this\.publisher\.(?:publish|publishFromSharedMemory)/g,
      ),
    ];
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const m of segments) {
      const segment = m[0];
      // The legacy empty-catch swallowed everything. New code's
      // catches are narrow; this regex matches only the legacy
      // "wrap the await + empty catch" shape.
      expect(segment).not.toMatch(
        /await\s+this\.chain\.getContextGraphRequiredSignatures[\s\S]{0,200}?\}\s*catch\s*\{[\s\S]{0,200}?\/\/\s*non-numeric/,
      );
    }
  });
});
