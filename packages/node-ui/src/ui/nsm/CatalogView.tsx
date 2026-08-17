// Surface 02 — Catalog (spec docs/ui-spec/surfaces/02-catalog.md).
// Cards grouped by canonical Model KA; prices only from verified live quotes;
// settled volume only from close-attested token sums.
import React, { useMemo, useState } from 'react';
import { copy } from './copy.generated.js';
import { ModelCard } from './components.js';
import { DEFAULT_TRAC_USD, usdPer1M } from './format.js';
import type { CatalogState } from './useCatalog.js';

type SortKey = 'settled' | 'price' | 'newest';

export function CatalogView({ cat, fxRate = DEFAULT_TRAC_USD, onOpenModel }: {
  cat: CatalogState; fxRate?: number; onOpenModel: (groupKey: string) => void;
}): React.ReactElement {
  const [search, setSearch] = useState('');
  const [prov, setProv] = useState<'all' | 'weights-pinned' | 'upstream-claimed'>('all');
  const [modality, setModality] = useState<'all' | string>('all');
  const [sort, setSort] = useState<SortKey>('settled');

  const modalities = useMemo(() => [...new Set(cat.models.map((m) => m.modality))], [cat.models]);

  const filtered = useMemo(() => {
    let ms = cat.models;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      ms = ms.filter((m) => m.displayName.toLowerCase().includes(q) || m.family.toLowerCase().includes(q));
    }
    if (prov !== 'all') ms = ms.filter((m) => m.providers.some((p) => p.class === prov));
    if (modality !== 'all') ms = ms.filter((m) => m.modality === modality);
    const price = (m: typeof ms[number]) => {
      const v = m.providers.filter((p) => Number.isFinite(p.inMicro)).map((p) => usdPer1M(p.inMicro, p.outMicro, fxRate));
      return v.length ? Math.min(...v) : Number.POSITIVE_INFINITY;
    };
    return [...ms].sort((a, b) =>
      sort === 'settled' ? b.settledTokens - a.settledTokens
      : sort === 'price' ? price(a) - price(b)
      : String(b.issuedAt ?? '').localeCompare(String(a.issuedAt ?? '')));
  }, [cat.models, search, prov, modality, sort, fxRate]);

  const clearFilters = () => { setSearch(''); setProv('all'); setModality('all'); };
  const anyFilter = search.trim() !== '' || prov !== 'all' || modality !== 'all';

  return (
    <div>
      <div className="filters" style={{ marginBottom: 'var(--sp-5)' }}>
        <input className="input" placeholder={copy('catalog.search')} aria-label={copy('catalog.search')}
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={modality} onChange={(e) => setModality(e.target.value)} aria-label="Modality">
          <option value="all">Modality</option>
          {modalities.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="input" value={prov} onChange={(e) => setProv(e.target.value as typeof prov)} aria-label="Provenance">
          <option value="all">Provenance</option>
          <option value="weights-pinned">{copy('prov.pinned')}</option>
          <option value="upstream-claimed">{copy('prov.claimed')}</option>
        </select>
        <select className="input sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="settled">Sort: Settled</option>
          <option value="price">Sort: Price</option>
          <option value="newest">Sort: Newest</option>
        </select>
      </div>

      {cat.loading && (
        <div className="grid-cards" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="card mcard">
              <div className="name"><span className="logo-monogram logo--md skel">··</span> <span className="skel">Model name</span></div>
              <div className="fam skel" style={{ width: '60%' }}>family</div>
              <div className="provline skel" style={{ width: '40%' }}>providers</div>
              <div className="price skel" style={{ width: '50%' }}>price</div>
            </div>
          ))}
        </div>
      )}

      {!cat.loading && cat.error && (
        <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
          <span className="sec">{copy('err.offline')}</span>
          <button className="btn" onClick={cat.refresh}>{copy('ctl.retry')}</button>
        </div>
      )}

      {!cat.loading && !cat.error && cat.models.length === 0 && (
        <div className="card card--pad" style={{ textAlign: 'center' }}>
          <span className="sec">{copy('empty.catalog')}</span>
        </div>
      )}

      {!cat.loading && !cat.error && cat.models.length > 0 && filtered.length === 0 && (
        <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
          <span className="sec">{copy('catalog.filter.zero')}</span>
          {anyFilter && <button className="btn btn--ghost btn--sm" onClick={clearFilters}>{copy('ctl.clear-filters')}</button>}
        </div>
      )}

      {!cat.loading && filtered.length > 0 && (
        <div className="grid-cards">
          {filtered.map((m) => (
            <ModelCard key={m.groupKey} model={m} fxRate={fxRate} onOpen={() => onOpenModel(m.groupKey)} />
          ))}
        </div>
      )}

      {/* catalog.metered takes over when P2's budgeted remote discovery lands */}
      <div className="footnote">{copy('catalog.free')}</div>
    </div>
  );
}
