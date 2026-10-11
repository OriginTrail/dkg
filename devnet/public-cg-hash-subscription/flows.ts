/**
 * Run independent, labeled flows side by side and report every failure under
 * its label.
 *
 * The hash-subscription suite's SWM test drives two edges through the same
 * sequence (admission, adoption, first-job alias checks, recovery, latest-job
 * alias checks). Neither edge waits for the other, so a slow recovery on one
 * does not spend the other's budget. Two properties matter and are tested
 * without a devnet (flows.test.ts):
 *
 *  - every flow is awaited to its end (`Promise.allSettled`), even after
 *    another one failed. With a bare `Promise.all` the test would end at the
 *    first rejection while the surviving flow kept polling and re-subscribing
 *    (`forceCatchup`) into the next test's time, unobserved;
 *  - every failure is reported under the flow's own label, so a failure names
 *    the edge and the way it subscribed, not just the assertion.
 */

/** One flow: `label` names it in a failure, `run` does the work. */
export interface LabeledFlow<T> {
  readonly label: string;
  readonly run: () => Promise<T>;
}

/** One failed flow. */
export interface FlowFailure {
  readonly label: string;
  readonly reason: unknown;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Start every flow at once and wait for all of them. Resolves to their values
 * in the order given. If any flow fails, rejects (after the others have
 * finished) with an `AggregateError` whose message lists every failed flow as
 * `[label] message`, whose `cause` is the first failure's own error and whose
 * `errors` are the failures in order.
 */
export async function runLabeledFlows<T>(flows: readonly LabeledFlow<T>[]): Promise<T[]> {
  // `async` turns a synchronous throw in `run` into a rejection, so the other flows are still awaited.
  const settled = await Promise.allSettled(flows.map(async (flow) => flow.run()));
  const failures: FlowFailure[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') failures.push({ label: flows[index]!.label, reason: outcome.reason });
  });
  if (failures.length > 0) {
    const message = failures.map((failure) => `[${failure.label}] ${describe(failure.reason)}`).join('\n');
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${failures.length} of ${flows.length} flow(s) failed:\n${message}`,
      { cause: failures[0]!.reason },
    );
  }
  return settled.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}
