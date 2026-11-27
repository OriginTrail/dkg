// SPDX-License-Identifier: Apache-2.0
/** A Hub miss is told from any other failure by its type alone, never by an error's text or name. */
import { describe, expect, it } from 'vitest';
import {
  HubAssetStorageNotFoundError,
  HubBindingNotFoundError,
  HubContractNotFoundError,
  isHubBindingNotFoundError,
} from '../src/index.js';

const HUB = '0x0000000000000000000000000000000000000001';

describe('isHubBindingNotFoundError', () => {
  it('is true for every typed Hub miss', () => {
    for (const miss of [
      new HubBindingNotFoundError('contract', 'Chronos', HUB),
      new HubContractNotFoundError('ServiceSubscriptions', HUB),
      new HubAssetStorageNotFoundError('KnowledgeCollectionStorage', HUB),
    ]) {
      expect(isHubBindingNotFoundError(miss)).toBe(true);
    }
  });

  it('is false for anything else, a lookalike included', () => {
    const lookalike = Object.assign(new Error('Contract "Chronos" not found in Hub'), { name: 'HubContractNotFoundError' });
    for (const other of [lookalike, new Error('timed out after 30000ms'), 'HubContractNotFoundError', undefined, null]) {
      expect(isHubBindingNotFoundError(other)).toBe(false);
    }
  });
});
