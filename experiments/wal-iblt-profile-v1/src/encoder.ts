import { compareBytes } from './bytes.js';
import { CodingWindow } from './coding-window.js';
import type { MappingProfile } from './profile.js';
import type { ReconciliationSymbolV1 } from './symbol.js';

export class RatelessIbltEncoder {
  readonly #window: CodingWindow;

  constructor(ids: readonly Uint8Array[], reconciliationSeed: Uint8Array, mappingProfile: MappingProfile) {
    this.#window = new CodingWindow(reconciliationSeed, mappingProfile);
    const sorted = [...ids].sort(compareBytes);
    for (const id of sorted) this.#window.addId(id);
  }

  get nextSymbolIndex(): number {
    return this.#window.nextSymbolIndex;
  }

  produceNext(): ReconciliationSymbolV1 {
    return this.#window.produceNext();
  }

  produceWindow(length: number): ReconciliationSymbolV1[] {
    if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError('window length must be a positive safe integer');
    return Array.from({ length }, () => this.produceNext());
  }
}
