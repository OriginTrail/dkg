// Who is who — four identities the operator must be able to tell apart:
// the node's operations wallet (gas + publishing, never a buyer), the
// connected purchase wallet (pays, signs the binding), each provider's
// identity, and that provider's dedicated revenue wallet.
import React from 'react';
import { copy } from '../copy.generated.js';
import { shortAddr } from './shared.js';

export interface SellerIdentity { seller: string; revenueWallet: string | null }

export function IdentityStrip({ opsWallet, buyer, sellers, chainLabel }: {
  opsWallet: string | null; buyer: string | null; sellers: SellerIdentity[]; chainLabel?: string | null;
}): React.ReactElement {
  return (
    <div className="mkt-idstrip" data-testid="mkt-identity-strip">
      <div className="mkt-id">
        <span className="mkt-id-k" data-copy="purchase.identity.ops">{copy('purchase.identity.ops')}</span>
        <span className="mkt-mono" title={opsWallet ?? ''} data-copy="_data">{shortAddr(opsWallet)}</span>
        <span className="mkt-muted mkt-xs" data-copy="purchase.identity.ops.note">{copy('purchase.identity.ops.note')}</span>
      </div>
      <div className="mkt-id buyer">
        <span className="mkt-id-k" data-copy="purchase.identity.buyer">{copy('purchase.identity.buyer')}</span>
        <span className="mkt-mono" title={buyer ?? ''} data-copy="_data">{buyer ? shortAddr(buyer) : copy('wallet.none')}</span>
        <span className="mkt-muted mkt-xs" data-copy="purchase.identity.buyer.note">{copy('purchase.identity.buyer.note')}</span>
        {chainLabel && <span className="mkt-muted mkt-xs" data-copy="_data">{chainLabel}</span>}
      </div>
      {sellers.map((s) => (
        <div className="mkt-id seller" key={s.seller}>
          <span className="mkt-id-k" data-copy="purchase.identity.seller">{copy('purchase.identity.seller')}</span>
          <span className="mkt-mono" title={s.seller} data-copy="_data">{shortAddr(s.seller)}</span>
          <span className="mkt-id-k" data-copy="purchase.identity.revenue">{copy('purchase.identity.revenue')}</span>
          <span className="mkt-mono" title={s.revenueWallet ?? ''} data-copy="_data">{shortAddr(s.revenueWallet)}</span>
          <span className="mkt-muted mkt-xs" data-copy="purchase.identity.revenue.note">{copy('purchase.identity.revenue.note')}</span>
        </div>
      ))}
    </div>
  );
}
