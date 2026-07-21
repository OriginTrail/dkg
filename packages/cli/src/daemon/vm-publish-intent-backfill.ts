// #1828 — daemon-boot backfill of the durable-admission intent-recovery index.
//
// Extracted from `runDaemonInner` so the fail-open contract (a backfill error
// must NEVER abort boot) and the count-logging behaviour are unit-testable
// without driving the whole daemon-start path. Depends only on the narrow
// VmPublishIntentIndexBackfiller maintenance interface (exported by the publisher
// package), never on the runtime publisher contract.

import type { VmPublishIntentIndexBackfiller } from '@origintrail-official/dkg-publisher';

/**
 * Run the one-time, additive intent-index backfill for VM-publish jobs admitted
 * before the index existed. Additive insert (RDF set-semantics) means it is safe
 * to run before the runner starts and cannot race in-flight writes. Fail-open:
 * a backfill error is logged and swallowed so a hiccup never blocks boot.
 */
export async function backfillVmPublishIntentIndexOnBoot(
  publisherControl: VmPublishIntentIndexBackfiller,
  log: (message: string) => void,
): Promise<void> {
  try {
    const indexed = await publisherControl.ensureVmPublishIntentIndex();
    if (indexed > 0) log(`Publisher: backfilled intent-recovery index for ${indexed} job(s)`);
  } catch (err) {
    log(`Publisher: intent-index backfill skipped (${(err as Error)?.message ?? String(err)})`);
  }
}
