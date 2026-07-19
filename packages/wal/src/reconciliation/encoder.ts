import {
  DEFAULT_RECONCILIATION_LIMITS,
  ReconciliationBudget,
  type ReconciliationClock,
  type ReconciliationLimits,
  type ReconciliationUsage
} from './budget.js';
import { CodingWindow } from './coding-window.js';
import type { ProtocolV1IbltReconciliationAlgorithm } from './configuration.js';
import { ReconciliationError } from './errors.js';
import { prepareWalObjectIdInput, type WalObjectIdInput } from './input.js';
import type { ReconciliationSeed, WalObjectId } from './ids.js';
import type { ReconciliationSymbolV1 } from './symbol.js';
import { encodeReconciliationSymbolV1 } from './wire.js';

export interface RatelessIbltEncoderOptions extends WalObjectIdInput {
  reconciliationSeed: ReconciliationSeed;
  algorithm: ProtocolV1IbltReconciliationAlgorithm;
  limits?: Readonly<ReconciliationLimits>;
  clock?: ReconciliationClock;
}

export class RatelessIbltEncoder {
  readonly #window: CodingWindow;
  readonly #budget: ReconciliationBudget;

  constructor(options: RatelessIbltEncoderOptions) {
    this.#budget = new ReconciliationBudget(options.limits ?? DEFAULT_RECONCILIATION_LIMITS, options.clock);
    const input = prepareWalObjectIdInput(options);
    this.#window = new CodingWindow(
      options.reconciliationSeed,
      options.algorithm.mapping,
      this.#budget,
      { expectedIds: input.idCount, trackDuplicateIds: false }
    );
    for (const id of input.ids) this.#window.addId(id);
  }

  get nextSymbolIndex(): number {
    return this.#window.nextSymbolIndex;
  }

  get usage(): ReconciliationUsage {
    return this.#budget.snapshot();
  }

  produceNext(): ReconciliationSymbolV1 {
    this.#budget.acceptSymbol();
    return this.#window.produceNext();
  }

  produceWindow(length: number): ReconciliationSymbolV1[] {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'window length must be a positive safe integer');
    }
    return Array.from({ length }, () => this.produceNext());
  }

  produceEncodedWindow(length: number): Uint8Array[] {
    return this.produceWindow(length).map(encodeReconciliationSymbolV1);
  }
}
