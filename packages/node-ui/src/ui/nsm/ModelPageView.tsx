// Surface 03 — Model page (spec docs/ui-spec/surfaces/03-model-page.md).
// One sortable table of provider variants; every row's price/endpoint from
// its VERIFIED live quote (the node's quote proxy); rep from close KAs;
// TTFT/tok-s from the local telemetry store only — never invented.
import React, { useMemo, useState } from 'react';
import { copy } from './copy.generated.js';
import { ModelLogo, ProviderRow, type CatalogProvider, type QuoteStatus } from './components.js';
import { DEFAULT_TRAC_USD, fmtCompact, fmtHash, usdPer1M } from './format.js';
import type { CatalogState } from './useCatalog.js';

type SortKey = 'price' | 'ttft' | 'toks';

export function ModelPageView({ cat, groupKey, fxRate = DEFAULT_TRAC_USD, onBack, onTry }: {
  cat: CatalogState; groupKey: string; fxRate?: number;
  onBack: () => void; onTry?: (modelKey: string, provider: string) => void;
}): React.ReactElement {
  const [sort, setSort] = useState<SortKey>('price');
  const [popover, setPopover] = useState<string | null>(null);

  const model = cat.models.find((m) => m.groupKey === groupKey);

  const rows = useMemo(() => {
    if (!model) return [];
    const val = (p: CatalogProvider & { quoteStatus?: QuoteStatus }) =>
      sort === 'price' ? (Number.isFinite(p.inMicro) ? usdPer1M(p.inMicro, p.outMicro, fxRate) : Number.POSITIVE_INFINITY)
      : sort === 'ttft' ? (p.ttftMs ?? Number.POSITIVE_INFINITY)
      : -(p.tokS ?? Number.NEGATIVE_INFINITY);
    return [...model.providers].sort((a, b) => val(a) - val(b));
  }, [model, sort, fxRate]);

  if (!model) {
    return (
      <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
        <span className="sec">{copy('empty.catalog')}</span>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>{copy('ctl.back')}</button>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>← {copy('ctl.back')}</button>
      </div>
      <div className="mhead" style={{ marginBottom: 'var(--sp-5)' }}>
        <ModelLogo family={model.family} displayName={model.displayName} size="lg" />
        <h1>{model.displayName}</h1>
        <div className="chips">
          <span className="chip">{model.family}</span>
          <span className="chip">{model.modality}</span>
          {model.contextLength > 0 && <span className="chip">{fmtCompact(model.contextLength)} context</span>}
          {model.quantization && <span className="chip mono">{model.quantization}</span>}
        </div>
      </div>

      <div className="card scroll-x">
        <table className="table">
          <thead><tr>
            <th>Provider</th>
            <th className="num sortable" onClick={() => setSort('price')}>Price / 1M</th>
            <th>Class</th>
            <th className="num sortable" onClick={() => setSort('ttft')}>TTFT</th>
            <th className="num sortable" onClick={() => setSort('toks')}>tok/s</th>
            <th>Via</th><th>Up</th><th />
          </tr></thead>
          <tbody>
            {rows.map((p) => {
              const qs = (p as CatalogProvider & { quoteStatus?: QuoteStatus }).quoteStatus ?? 'loading';
              return (
                <React.Fragment key={p.addr}>
                  <ProviderRow p={p} fxRate={fxRate} quoteStatus={qs}
                    onRepClick={() => setPopover(popover === p.addr ? null : p.addr)}
                    onTry={onTry ? () => onTry(model.groupKey, p.addr) : undefined} />
                  {popover === p.addr && p.rep && (
                    <tr><td colSpan={8}>
                      <div className="drawer" style={{ maxWidth: 'calc(var(--card-min-w) + var(--sp-10))' }}>
                        <div className="sm" style={{ marginBottom: 'var(--sp-2)' }}>
                          <span className="mono">{fmtHash(p.addr)}</span> · {copy('model.rep', { a: p.rep.verified, d: p.rep.disputed })}
                        </div>
                        <div className="sm sec">{copy('model.rep.tip')}</div>
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="xs muted" style={{ marginTop: 'var(--sp-2)' }}>{copy('model.quote.provenance')}</div>
    </div>
  );
}
