import type { PreBroadcastSignal, ReplacementBroadcastSignal } from '@origintrail-official/dkg-chain';
import type { PhaseCallback, PreBroadcastRecord } from './publisher.js';

/**
 * GH#2270 PR-3 r4 — the ONE write-ahead hook for both signing paths.
 *
 * `publish` and `update` each carried a private copy of the same three-part contract: a once-only
 * latch (adapters may invoke `onBroadcast` more than once across retries, the boundary must fire
 * once), the hash-bearing `chain:txsigned` breadcrumb and `chain:writeahead:start`
 * instrumentation FIRST, and the durable `onBeforeBroadcast` callback LAST — awaited, so nothing
 * fallible runs between the durable record and the send, and a throw anywhere in here aborts the
 * broadcast with the record and the wire still agreeing. Two copies of an ordering contract is
 * two places for the order to be edited in one; this is the single owner.
 *
 * The phase-name-encodes-the-hash convention (PR #241): `PhaseCallback` is a 2-arg function, so
 * the signed tx identity travels as `chain:txsigned:tx-<hash>`, emitted as a balanced start/end
 * pair to preserve the golden-sequence "every start has a matching end" invariant. The durable
 * callback used to run FIRST; a rejecting `onPhase` after it then aborted the broadcast with the
 * 'broadcast' record already on disk — a persisted transaction that was never sent (r3).
 *
 * `didWriteAhead()` is how the call sites keep the surrounding `try/finally` contract: the
 * balancing `chain:writeahead:end` is emitted only if `:start` actually fired.
 *
 * `onBeforeReplacementBroadcast` is the adapter's stuck-transaction speed-up opt-in, offered only
 * when no durable `onBeforeBroadcast` is attached. That record (the async publisher's) holds
 * exactly one hash per transaction, and its recovery recognizes no other: a same-nonce replacement
 * mined in place of that hash would leave the job holding its wallet with a publish it cannot
 * see. Without it the result simply carries whichever hash was mined, and the replacement's
 * identity travels as a `chain:txreplaced:tx-<hash>` breadcrumb, as the original's does.
 */
export function createWriteAheadHook(hooks: {
  onPhase?: PhaseCallback;
  onBeforeBroadcast?: (record: PreBroadcastRecord) => Promise<void> | void;
  /**
   * GH#2270 PR #2300 r3 — WHICH BRANCH is signing, recorded because it cannot be inferred later.
   * Recovery's absence-release is create-only, and the job's request does not settle the question:
   * the queued publish resolves its update branch from `request.vmCurrentAssertion ?? the live
   * lifecycle pointer`, so a request carrying no pointer of its own can still sign an update. The
   * one moment the answer is certain is here, at the signing site, and it is a static fact of the
   * call site: this builder's two consumers ARE the two branches.
   */
  operationKind: 'create' | 'update';
}): {
  emitWriteAheadStart: (signal: PreBroadcastSignal) => Promise<void>;
  didWriteAhead: () => boolean;
  onBeforeReplacementBroadcast?: (signal: ReplacementBroadcastSignal) => Promise<void>;
} {
  const { onPhase, onBeforeBroadcast, operationKind } = hooks;
  let wroteAhead = false;
  const emitPhase = async (phase: string, status: 'start' | 'end') => {
    await (onPhase?.(phase, status) as unknown as Promise<void> | void);
  };
  return {
    didWriteAhead: () => wroteAhead,
    // The signal is REQUIRED (r3 3811569467): a call with no signed transaction would latch the
    // hook, emit the write-ahead phase, skip the durable callback, and then suppress the real
    // signal that follows — a state the chain interface never produces and this contract must
    // not permit.
    emitWriteAheadStart: async (signal: PreBroadcastSignal) => {
      if (wroteAhead) return;
      wroteAhead = true;
      // Instrumentation runs FIRST. It is caller-supplied and therefore fallible, and it is
      // awaited, so a rejecting listener aborts the send — which is fine, and even desirable,
      // as long as nothing durable has been written yet.
      const phase = `chain:txsigned:tx-${signal.txHash}`;
      await emitPhase(phase, 'start');
      await emitPhase(phase, 'end');
      await emitPhase('chain:writeahead', 'start');
      // The DURABLE boundary is LAST, so nothing fallible runs between it and the send.
      await onBeforeBroadcast?.({ ...signal, operationKind });
    },
    ...(onBeforeBroadcast === undefined
      ? {
        onBeforeReplacementBroadcast: async (signal: ReplacementBroadcastSignal) => {
          const phase = `chain:txreplaced:tx-${signal.txHash}`;
          await emitPhase(phase, 'start');
          await emitPhase(phase, 'end');
        },
      }
      : {}),
  };
}
