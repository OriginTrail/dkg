// /dev/gallery: the marketplace's building blocks in their states, fed by the
// fixture node's answers (api/fixtures.ts), never by a live node, and
// labeled as such. Nothing on this page sends a request.
import React, { useState } from 'react';
import { PageHeader } from '../components/ds/PageHeader.js';
import { copy } from './copy.generated.js';
import { errorOf } from './api/client.js';
import { FIXTURE_IDS, FIXTURE_SECRET, fixtureWorld } from './api/fixtures.js';
import type { MadeKey, Preview, ServiceRequest, SourceRequest } from './api/types.js';
import { fmtCount, fmtTrac, modelName } from './amounts.js';
import { AdminCard, ErrorCard, OffCard, refusalKey, sellerName } from './shared.js';
import { PriceLine, ProvBadge, SellerChip } from './views/MarketplaceView.js';
import { Meters } from './purchase/Meters.js';
import { Activity } from './purchase/Ledger.js';
import { ConfirmGate } from './purchase/ConfirmGate.js';
import { KeyOnce } from './purchase/KeyStep.js';
import type { Confirming } from './purchase/model.js';
import { ProgressSteps } from './purchase/ProgressSteps.js';

function Sect({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <div className="state-label">{title}</div>
      {children}
    </>
  );
}

/** Refusals in both of the node's shapes, as it sends them: the status, the body, and the Retry-After header. */
const REFUSALS: Array<[number, unknown, string | null]> = [
  [503, { error: 'The marketplace is off on this node', code: 'MarketplaceOff', retryable: true }, null],
  [403, { error: 'A node-admin token is required', code: 'NodeAdminRequired', retryable: false }, null],
  [409, { error: 'InsufficientAllowance(7, 664, 5, 2)', code: 'InsufficientAllowance', args: ['7', '664', '5', '2'], retryable: false }, null],
  [503, { error: { code: 'epoch_ending', message: 'the epoch is ending; calls resume when the next one starts', type: 'marketplace' }, nextEpochAt: 0 }, '120'],
  [402, { error: { code: 'soft_ceiling', message: 'the budget is at its soft ceiling', type: 'marketplace' }, left: '0', leftTrac: '0.0', fork: { topUp: true } }, null],
  [502, { error: { code: 'bad_receipt', message: "the seller's receipt failed a check: value_mismatch", type: 'marketplace' }, problem: 'value_mismatch' }, null],
];

export function MarketplaceGalleryView(): React.ReactElement {
  const [world] = useState(() => fixtureWorld());
  const [keyShown, setKeyShown] = useState(true);
  const catalog = world.catalog(true);
  const noFx = { ...catalog.fx, tracUsd: null, source: 'none', asOf: null };
  const qwen = catalog.services.find((s) => s.serviceId === FIXTURE_IDS.qwen14b)!;
  const services: ServiceRequest[] = world.plan(true).services.map((s) => ({ serviceId: s.serviceId, serviceClass: s.serviceClass, value: s.value, maxPricePerUnit: s.maxPricePerUnit }));
  const preview: Preview = { epoch: world.epoch, source: { kind: 'account', accountId: '7', discountBps: 1_000 }, value: world.current.value, valueTrac: world.current.valueTrac, cost: '4500000000000000000', costTrac: '4.5', discountBps: 1_000 };
  const source: SourceRequest = { kind: 'account', accountId: '7' };
  const confirming: Confirming = {
    kind: 'fund', request: { epoch: world.epoch, source, services }, preview, plan: { services, source, renew: true, renewUntilEpoch: world.epoch + 6 },
  };
  const made: MadeKey = { ...world.keys[0], keyId: FIXTURE_SECRET.slice(0, 14), label: 'my-agent', spent: '0', reserved: '0', lastUsedAt: null, secret: FIXTURE_SECRET };
  const served = world.chat(world.labels[FIXTURE_IDS.qwen14b], FIXTURE_IDS.qwen14b).marketplace;
  const noop = () => undefined;

  return (
    <div className="mktx mktx--page">
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'color-mix(in srgb, var(--state-pending) 14%, var(--surface-0))',
        color: 'var(--state-pending)', borderBottom: '1px solid var(--border-subtle)',
        fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' as unknown as number,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: 'var(--sp-2) var(--sp-4)',
      }}>
        {copy('gallery.banner')}
      </div>
      <div className="frame mkt-frame">
        <PageHeader title={copy('gallery.title')} />

        <Sect title={copy('gallery.sect.calls')}>
          <div className="mkt-fchips mkt-wrap" data-testid="mkt-gallery-calls">
            {(['held', 'landed', 'missed'] as const).map((s) => (
              <span key={s} className={s === 'missed' ? 'mkt-chipblock' : s === 'held' ? 'mkt-chipwarn' : 'mkt-chipleft'}>{copy(`activity.state.${s}`)}</span>
            ))}
          </div>
        </Sect>

        <Sect title={copy('gallery.sect.sellers')}>
          <div className="mkt-fchips mkt-wrap">
            <SellerChip available /><SellerChip available={false} /><SellerChip available={null} />
            <ProvBadge offers={world.offers[FIXTURE_IDS.qwen14b]} /><ProvBadge offers={world.offers[FIXTURE_IDS.llama8b]} />
          </div>
        </Sect>

        <Sect title={copy('gallery.sect.prices')}>
          <div className="mkt-card">
            <div><strong>{modelName(qwen.label)}</strong>{' '}<PriceLine min={qwen.priceMin} max={qwen.priceMax} fx={catalog.fx} /></div>
            <div><strong>{modelName(qwen.label)}</strong>{' '}<PriceLine min={qwen.priceMin} max={qwen.priceMax} fx={noFx} /></div>
            <span className="mkt-chipleft">{copy('catalog.covered', { trac: fmtTrac(qwen.covered!.left) })}</span>
          </div>
        </Sect>

        <Sect title={copy('gallery.sect.budgets')}>
          <Meters subscription={world.current} catalog={catalog} plan={world.plan(true)} calls={world.activity.calls} onTopUp={noop} />
        </Sect>

        <Sect title={copy('gallery.sect.served')}>
          <div className="mkt-card mkt-chat">
            <div className="mkt-bubble assistant">{world.chat('', FIXTURE_IDS.qwen14b).choices[0].message.content}</div>
            <div className="mkt-muted mkt-xs">{copy('play.servedby', { seller: sellerName(served.seller), units: fmtCount(served.units), trac: fmtTrac(served.value), left: fmtTrac(served.budgetLeft) })}</div>
            <div className="mkt-bubble assistant error" role="alert">{copy('play.error.bubble', { reason: copy(refusalKey('soft_ceiling')) })}</div>
          </div>
        </Sect>

        <Sect title={copy('gallery.sect.steps')}>
          <ProgressSteps step={1} /><ProgressSteps step={2} sub="confirm" /><ProgressSteps step={3} />
        </Sect>

        <Sect title={copy('gallery.sect.gate')}>
          <ConfirmGate catalog={catalog} funding={world.funding} confirming={confirming} busy={false} err={null} onConfirm={noop} onCancel={noop} />
        </Sect>

        <Sect title={copy('gallery.sect.key')}>
          {keyShown ? <KeyOnce made={made} onDone={() => setKeyShown(false)} /> : <div className="mkt-muted mkt-xs" data-testid="mkt-gallery-key-gone">{copy('gallery.key.gone', { key: made.keyId })}</div>}
        </Sect>

        <Sect title={copy('gallery.sect.activity')}>
          <Activity catalog={catalog} calls={world.activity.calls} err={null} />
        </Sect>

        <Sect title={copy('gallery.sect.refusals')}>
          {REFUSALS.map(([status, body, retryAfter], i) => <ErrorCard key={i} err={errorOf(status, body, retryAfter)} />)}
        </Sect>

        <Sect title={copy('gallery.sect.states')}>
          <OffCard /><OffCard selling /><OffCard absent /><AdminCard what="admin.access" />
          {(['empty.activity', 'empty.keys', 'recon.none', 'catalog.empty.offers'] as const).map((k) => (
            <div key={k} className="mkt-card mkt-muted" style={{ textAlign: 'center' }}>{copy(k)}</div>
          ))}
        </Sect>
      </div>
    </div>
  );
}
