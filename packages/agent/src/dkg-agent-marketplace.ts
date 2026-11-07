// SPDX-License-Identifier: Apache-2.0

/**
 * The marketplace facade (OT-RFC-27): the chain adapter's marketplace surface,
 * for the daemon's buyer and its routes, as the account facade gives the
 * Conviction Account methods.
 */

import { marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';

export class MarketplaceAgentMethods extends DKGAgentBase {
  /** The chain's marketplace, or `null` when the chain has none (no chain configured). */
  marketplaceChain(): MarketplaceChainAdapter | null {
    return marketplaceChainOf(this.chain);
  }
}
