// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

import type {
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from './catalog-applied-head-coordinator-v1.js';

export const MAX_RFC64_FINALIZED_SWM_RETIREMENT_RECEIPT_HEADS_V1 = 128;

/**
 * Bounded process-local diagnostic evidence. Applied-head persistence remains
 * the durable source of truth; this registry only retains recent lifecycle
 * receipts for inspection and tests.
 */
export class Rfc64FinalizedSwmRetirementLifecycleReceiptRegistryV1 {
  readonly #maxHeads: number;
  readonly #receiptsByHead = new Map<
    Digest32V1,
    readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[]
  >();

  constructor(maxHeads = MAX_RFC64_FINALIZED_SWM_RETIREMENT_RECEIPT_HEADS_V1) {
    if (!Number.isSafeInteger(maxHeads) || maxHeads < 1) {
      throw new RangeError('finalized SWM retirement receipt maxHeads must be positive');
    }
    this.#maxHeads = maxHeads;
  }

  record(receipt: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>): void {
    const head = receipt.catalogHeadDigest;
    const previous = this.#receiptsByHead.get(head) ?? [];
    const next = [...previous.filter(({ kaUal }) => kaUal !== receipt.kaUal), clone(receipt)]
      .sort((left, right) => left.kaUal.localeCompare(right.kaUal));
    if (!this.#receiptsByHead.has(head)) {
      while (this.#receiptsByHead.size >= this.#maxHeads) {
        const oldest = this.#receiptsByHead.keys().next().value as Digest32V1 | undefined;
        if (oldest === undefined) break;
        this.#receiptsByHead.delete(oldest);
      }
    }
    this.#receiptsByHead.set(head, Object.freeze(next));
  }

  read(
    catalogHeadDigest: Digest32V1,
  ): readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[] {
    const receipts = this.#receiptsByHead.get(catalogHeadDigest) ?? [];
    return Object.freeze(receipts.map(clone));
  }

  clear(): void {
    this.#receiptsByHead.clear();
  }
}

function clone(
  receipt: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>,
): Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1> {
  return Object.freeze({
    ...receipt,
    committedHead: Object.freeze({ ...receipt.committedHead }),
  });
}
