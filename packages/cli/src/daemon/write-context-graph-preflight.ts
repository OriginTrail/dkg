import type { WritePreflightRescueOutcome } from './write-preflight-diagnostics.js';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { ContextGraphWritePreflightProbe } from '@origintrail-official/dkg-agent';
import { classifyWritePreflightFailure } from '@origintrail-official/dkg-agent/write-preflight-attribution';
import { sanitizeWritePreflightFailures, type WritePreflightDiagnosticFailure } from './write-preflight-attribution.js';
import { probeWritePreflight, type CoalescingProbeAgent } from './write-preflight-coalescing.js';

function hasActiveSyncedSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  return (
    probe.inMemorySubscription?.subscribed === true &&
    probe.inMemorySubscription.synced === true
  );
}

function hasAnySyncedSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  return (
    hasActiveSyncedSubscription(probe) ||
    (probe.persistedSubscription?.subscribed === true && probe.persistedSubscription.synced === true)
  );
}

function exactProbeIsLocallyWritable(
  probe: ContextGraphWritePreflightProbe,
  requireLocalWritable: boolean,
): boolean {
  // Typed boundary: never trust store-derived facts when the store was down.
  // (`exists !== true` below already blocks a bare `undefined`, but gating on
  // the required discriminant makes the "only-when-available" contract
  // explicit and future-proofs the predicate against new fact reads.)
  if (!probe.storeAvailable) return false;
  // Store-derived probe facts are tri-state (`undefined` = the store read
  // failed); only an explicit `true` counts as positive evidence here.
  if (probe.exists !== true) return false;
  if (!requireLocalWritable) {
    return hasActiveSyncedSubscription(probe) || probe.hasLocalContent === true || probe.declarationFound === true;
  }
  return hasActiveSyncedSubscription(probe) || probe.hasLocalContent === true;
}

function exactProbeCanFastAccept(
  probe: ContextGraphWritePreflightProbe,
  requireLocalWritable: boolean,
  callerAgentAddress: string | null,
  allowLocalExactFallback: boolean,
): boolean {
  if (!exactProbeIsLocallyWritable(probe, requireLocalWritable)) return false;
  if (!callerAgentAddress) {
    // Node-admin / trusted-local routes already opt into the exact-local
    // fallback below after listContextGraphs. When the exact probe has all of
    // the same positive evidence up front, accept a known PRIVATE graph here
    // instead of enumerating every context graph first. This does not broaden
    // access: scoped agent callers never set allowLocalExactFallback, and an
    // unavailable/unknown store cannot satisfy exactProbeIsLocallyWritable.
    return (
      probe.accessPolicy === "public" ||
      (allowLocalExactFallback && probe.accessPolicy === "private")
    );
  }
  return probe.callerAuthorized === true;
}

function exactProbeIsAuthoritativeBearerDeny(
  probe: ContextGraphWritePreflightProbe,
  callerAgentAddress: string | null,
): boolean {
  // An authoritative deny requires trustworthy store-derived facts
  // (declaration + private policy + caller-not-authorized). With the store
  // down these are UNKNOWN, so refuse to synthesize a deny from them.
  return (
    probe.storeAvailable &&
    !!callerAgentAddress &&
    probe.exists === true &&
    probe.declarationFound === true &&
    probe.accessPolicy === "private" &&
    probe.callerAuthorized === false
  );
}

function exactProbeIsStaleSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  // `!probe.exists` / `!probe.hasLocalContent` are truthy for UNKNOWN
  // (`undefined`) facts too, so this must only run against an AVAILABLE
  // store — otherwise a store outage would masquerade as a stale
  // subscription and reject a live write. The required `storeAvailable`
  // discriminant enforces that at the boundary.
  return (
    probe.storeAvailable &&
    hasAnySyncedSubscription(probe) &&
    !probe.exists &&
    !probe.hasLocalContent
  );
}

const writePreflightRescueLog = new Logger('daemon-http');

/** Bound for the last-resort on-chain rescue eth_call, so an RPC stack that
 *  hangs on connect cannot stall a write route that is already degraded.
 *  Exported so tests can drive the timeout branch without waiting the full
 *  production window; production callers never pass an override so the
 *  default behaviour is unchanged. */
export const WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS = 5_000;

/**
 * Track B (write-preflight resilience) — last-resort write-target acceptance
 * when BOTH validation legs failed (the exact preflight probe AND
 * listContextGraphs), i.e. the local store is unavailable and the daemon would
 * otherwise 503 every write until it recovers.
 *
 * The store-free accept DECISION lives behind the agent/preflight boundary:
 * this helper delegates to the agent's high-level
 * `validateWriteTargetDuringStoreOutage`, which OWNS the on-chain access-policy
 * semantics (registry onChainId + `isContextGraphActiveOnChain` + public
 * `getContextGraphAccessPolicy`). The daemon only bounds that call with a
 * timeout and emits the WARN log — it never assembles chain-policy meaning
 * itself.
 *
 * Why the agent requires positive PUBLIC proof (not just an in-memory
 * subscription): an active subscription proves the node HOSTS/tracks the CG,
 * but carries NO access-policy and NO per-caller authorization. The healthy
 * write-preflight denies an authenticated-but-unauthorized caller of a PRIVATE
 * CG (`exactProbeIsAuthoritativeBearerDeny`, accessPolicy `private`); that
 * verdict comes from the local `_meta` allowlist, which is exactly what's
 * unavailable while the store is down. Accepting a subscribed PRIVATE CG here
 * would silently convert that DENY into an accept for any authenticated caller.
 *
 * Anything short of that proof — chain says not-active/non-public, throws, times
 * out, or the adapter lacks a read — keeps today's fail-closed 503 verbatim.
 * This never converts an existing DENY into an accept: it runs only when the
 * exact probe was UNAVAILABLE (threw or degraded) AND the list leg threw, only
 * ever admits an id the registry ALREADY tracks (never a raw unknown candidate
 * → shadow-CG fail-closed holds), and only when that id is provably public (no
 * per-caller preflight deny exists to convert).
 */
export async function rescueWriteTargetWithoutStore(
  agent: {
    validateWriteTargetDuringStoreOutage?: (contextGraphId: string) => Promise<boolean>;
  },
  candidateId: string,
  unavailableMessage: string,
  timeoutMs: number = WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS,
): Promise<Exclude<WritePreflightRescueOutcome, 'not-attempted'>> {
  if (typeof agent.validateWriteTargetDuringStoreOutage !== 'function') return 'unsupported';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const activePublic = await Promise.race([
      agent.validateWriteTargetDuringStoreOutage(candidateId),
      new Promise<'deadline'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('deadline'), timeoutMs);
        // Allow the process to exit even if the chain promise never settles.
        timer.unref?.();
      }),
    ]);
    if (activePublic !== true) return activePublic === 'deadline' ? 'deadline' : 'denied';
  } catch {
    // The adapter did not prove public access; do not guess which dependency failed.
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
  writePreflightRescueLog.warn(
    createOperationContext('resolve'),
    `write preflight: accepting context graph "${candidateId}" via positive on-chain proof it is an active PUBLIC context graph — local store unavailable (${unavailableMessage})`,
  );
  return 'accepted';
}

/**
 * The outcome of the EXACT write-preflight probe leg, as a single discriminated
 * value so the list-fallback leg branches on one result instead of a cluster of
 * distant mutable booleans (otReviewAgent #1408):
 *   - `accept`        — fast-accept; the caller returns the candidate id.
 *   - `rejectUnknown` — a definitive, store-backed deny of a non-bare id; the
 *                       caller returns 404.
 *   - canonical outcomes are fully reduced to accept/reject/unavailable here;
 *     the HTTP resolver never re-interprets raw probe fields.
 *   - the three `list*` variants are mutually exclusive: ordinary list/name
 *     resolution, an authoritative exact deny deferred for bare-name suffix
 *     resolution, or an unavailable exact probe whose list failure may use
 *     the store-free rescue.
 */
type ExactPreflightDecision =
  | { kind: "accept" }
  | { kind: "rejectUnknown" }
  | { kind: "rejectNonWritable" }
  | { kind: "validationUnavailable"; errorMessage: string; attribution: WritePreflightDiagnosticFailure[] }
  | { kind: "unavailableWithRescue"; errorMessage: string; attribution: WritePreflightDiagnosticFailure[] }
  | { kind: "listFallback" }
  | { kind: "listDeferredReject" }
  | { kind: "listUnavailable"; errorMessage: string; attribution: WritePreflightDiagnosticFailure[] };

/**
 * Run the exact write-preflight probe and reduce it to one {@link
 * ExactPreflightDecision}. Owns the probe interpretation (fast-accept,
 * degraded-store, authoritative deny) so `resolveRequiredWriteContextGraphId`
 * never re-synchronises availability/deferral/diagnostic flags across branches.
 * Deliberately takes no `ServerResponse` — HTTP responses stay with the caller.
 */
export async function evaluateExactWritePreflight(
  agent: Partial<CoalescingProbeAgent>,
  candidateId: string,
  opts: {
    callerAgentAddress: string | null;
    requireLocalWritable: boolean;
    isBareCandidateId: boolean;
    allowLocalExactFallback: boolean;
    /** The second pass after a readiness wait: it must not join a probe that began before the wait ended. */
    freshProbe?: boolean;
  },
): Promise<ExactPreflightDecision> {
  const {
    callerAgentAddress,
    requireLocalWritable,
    isBareCandidateId,
    allowLocalExactFallback,
  } = opts;
  if (!agent.probeContextGraphWritePreflight) {
    // Compatibility for narrow providers that do not expose the exact point
    // capability. Production agents do expose it; their canonical path below
    // never enumerates the catalog.
    return { kind: "listFallback" };
  }
  try {
    const fastAccepts = (candidate: ContextGraphWritePreflightProbe): boolean => exactProbeCanFastAccept(
      candidate,
      requireLocalWritable,
      callerAgentAddress,
      allowLocalExactFallback,
    );
    const exact = await probeWritePreflight(agent as CoalescingProbeAgent, candidateId, callerAgentAddress, {
      accepts: fastAccepts,
      fresh: opts.freshProbe,
    });
    const probe = exact.probe;
    // Fast-accept wins even under a degraded store (it never rests on UNKNOWN
    // store fields), so check it before any deny/unavailable interpretation.
    if (fastAccepts(probe)) {
      exact.fastAccepted();
      return { kind: "accept" };
    }
    const attribution = probeAttribution(probe);
    if (attribution.length === 0) attribution.push({ site: 'exact-probe', kind: 'unknown' });
    if (probe.storeUnavailable === true) {
      // The probe survived a store failure and degraded its store-derived
      // fields to UNKNOWN. Deny-ish verdicts are NOT trustworthy from unknowns
      // (that would turn a store outage into a 400), so carry the store error
      // for the both-legs-failed 503 and leave the verdict to the list/rescue.
      const errorMessage = probe.storeErrorMessage ?? "local store unavailable";
      return isBareCandidateId
        ? { kind: "listUnavailable", errorMessage, attribution }
        : { kind: "unavailableWithRescue", errorMessage, attribution };
    }
    // Store answered definitively — a deny-ish verdict is authoritative. Bare
    // ids defer (the list leg may resolve the name); qualified ids reject now.
    if (
      exactProbeIsStaleSubscription(probe) ||
      exactProbeIsAuthoritativeBearerDeny(probe, callerAgentAddress)
    ) {
      return isBareCandidateId
        ? { kind: "listDeferredReject" }
        : { kind: "rejectUnknown" };
    }
    if (!isBareCandidateId) {
      if (probe.exists === false) return { kind: "rejectUnknown" };
      if (probe.exists !== true) {
        return {
          kind: "validationUnavailable",
          errorMessage: "exact context graph existence was incomplete",
          attribution: [{ site: 'existence', kind: 'incomplete' }],
        };
      }
      if (!exactProbeIsLocallyWritable(probe, requireLocalWritable)) {
        return { kind: "rejectNonWritable" };
      }
      return {
        kind: "validationUnavailable",
        errorMessage: "exact context graph metadata was incomplete",
        attribution: [{ site: 'metadata', kind: 'incomplete' }],
      };
    }
    return { kind: "listFallback" };
  } catch (err) {
    // The exact probe could not answer local existence at all (store down / read
    // broke). The ONLY degraded case that makes the both-legs-failed rescue
    // eligible: there is no authoritative local-miss verdict to override.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const attribution: WritePreflightDiagnosticFailure[] = [{ site: 'exact-probe', kind: classifyWritePreflightFailure(err) }];
    return isBareCandidateId
      ? { kind: "listUnavailable", errorMessage, attribution }
      : { kind: "unavailableWithRescue", errorMessage, attribution };
  }
}


function probeAttribution(probe: ContextGraphWritePreflightProbe): WritePreflightDiagnosticFailure[] {
  try { return sanitizeWritePreflightFailures(probe.failureAttribution); }
  catch { return [{ site: 'exact-probe', kind: 'unknown' }]; }
}
