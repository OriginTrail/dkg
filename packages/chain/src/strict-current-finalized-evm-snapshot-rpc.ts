import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import type { StrictCurrentFinalizedEvmReadCallV1 } from './current-finalized-evm-read-model.js';
import {
  createCurrentFinalizedEvmSnapshotBudgetV1,
  type StrictCurrentFinalizedEvmSnapshotScopeV1,
  type StrictCurrentFinalizedEvmSnapshotSessionV1,
} from './current-finalized-evm-snapshot.js';
import {
  snapshotCurrentFinalizedEvmSnapshotCallsV1,
  snapshotCurrentFinalizedEvmSnapshotRequestV1,
} from './current-finalized-evm-read-validation.js';
import {
  resourceLimited,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import {
  createStrictFinalizedSnapshotTransportV1,
  type StrictFinalizedSnapshotTransportSessionV1,
} from './strict-current-finalized-evm-snapshot-transport.js';
import type { StrictRpcConfigSnapshotV1 } from './strict-current-finalized-evm-types.js';

interface SnapshotReadSessionControllerV1 {
  readonly session: StrictCurrentFinalizedEvmSnapshotSessionV1;
  readonly closeAndDrain: () => Promise<boolean>;
}

/** Package-internal runtime for a scoped, pinned finalized snapshot. */
export function createStrictFinalizedSnapshotRpcRuntimeV1(
  config: StrictRpcConfigSnapshotV1,
): StrictCurrentFinalizedEvmSnapshotScopeV1 {
  const transport = createStrictFinalizedSnapshotTransportV1(config);
  const withSnapshot: StrictCurrentFinalizedEvmSnapshotScopeV1 = async (
    inputRequest,
    consume,
  ) => {
    const request = snapshotCurrentFinalizedEvmSnapshotRequestV1(inputRequest);
    if (typeof consume !== 'function') {
      throw unavailable('Current-finalized snapshot consumer must be callable');
    }
    return transport(request, async (transportSession) => {
      const readSession = createSnapshotReadSession(transportSession);
      return runConsumerWithDrainedReads(readSession, consume);
    });
  };
  return Object.freeze(withSnapshot);
}

function createSnapshotReadSession(
  transportSession: StrictFinalizedSnapshotTransportSessionV1,
): Readonly<SnapshotReadSessionControllerV1> {
  const budget = createCurrentFinalizedEvmSnapshotBudgetV1();
  let active = true;
  let inFlight: Promise<readonly string[]> | undefined;
  const read = Object.freeze((
    inputCalls: readonly StrictCurrentFinalizedEvmReadCallV1[],
  ): Promise<readonly string[]> => {
    if (!active) {
      return handledRejectedRead(unavailable('Current-finalized snapshot session is closed'));
    }
    if (inFlight !== undefined) {
      return handledRejectedRead(new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        'Current-finalized snapshot permits only one dynamic batch at a time',
      ));
    }
    let calls: readonly StrictCurrentFinalizedEvmReadCallV1[];
    try {
      calls = snapshotCurrentFinalizedEvmSnapshotCallsV1(inputCalls);
    } catch (cause) {
      return handledRejectedRead(cause);
    }
    try {
      budget.consume(calls);
    } catch {
      return handledRejectedRead(resourceLimited(
        'Current-finalized snapshot exceeded its fixed scan budget',
      ));
    }
    const operation = transportSession.read(calls);
    const clearInFlight = () => {
      if (inFlight === operation) inFlight = undefined;
    };
    // Attach both handlers to the same promise exposed to the consumer. This
    // lets the scope own/drain an unawaited rejection without creating a
    // second rejecting wrapper promise that can surface as unhandled.
    void operation.then(clearInFlight, clearInFlight);
    inFlight = operation;
    return operation;
  });
  const session = Object.freeze({
    chainId: transportSession.chainId,
    blockNumber: transportSession.blockNumber,
    blockHash: transportSession.blockHash,
    read,
  } satisfies StrictCurrentFinalizedEvmSnapshotSessionV1);
  return Object.freeze({
    session,
    closeAndDrain: async (): Promise<boolean> => {
      active = false;
      const danglingRead = inFlight;
      if (danglingRead === undefined) return false;
      await danglingRead.catch(() => undefined);
      return true;
    },
  });
}

async function runConsumerWithDrainedReads<T>(
  readSession: Readonly<SnapshotReadSessionControllerV1>,
  consume: (session: StrictCurrentFinalizedEvmSnapshotSessionV1) => Promise<T>,
): Promise<T> {
  let execution:
    | Readonly<{ readonly ok: true; readonly value: T }>
    | Readonly<{ readonly ok: false; readonly failure: unknown }>;
  try {
    execution = Object.freeze({ ok: true, value: await consume(readSession.session) });
  } catch (cause) {
    execution = Object.freeze({ ok: false, failure: cause });
  }
  const hadDanglingRead = await readSession.closeAndDrain();
  if (execution.ok && hadDanglingRead) {
    throw unavailable(
      'Current-finalized snapshot consumer settled with an unawaited read in flight',
    );
  }
  if (!execution.ok) throw execution.failure;
  return execution.value;
}

function handledRejectedRead(cause: unknown): Promise<never> {
  const rejected = Promise.reject(cause);
  void rejected.catch(() => undefined);
  return rejected;
}
