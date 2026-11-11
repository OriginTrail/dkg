// This epoch's subscription, budget by budget: a bar of landed, held and
// left value with the 95% mark where calls stop, about how many tokens are
// left at the cap, and the reset at the epoch's end. At the soft ceiling, the
// fork: top up, or wait for the next epoch. Each budget's pace comes from
// this node's own calls.
import React, { useMemo } from 'react';
import { copy, type CopyKey } from '../copy.generated.js';
import type { Budget, Call, CatalogAnswer, Plan, Subscription } from '../api/types.js';
import { fmtCount, fmtMicro, fmtTrac, modelName, pctOf, sumWei, unitsOf } from '../amounts.js';
import { relAt, sellerName } from '../shared.js';

const freeOf = (b: Budget): bigint => { const f = BigInt(b.left) - BigInt(b.held); return f > 0n ? f : 0n; };
/** Calls stop once landed and held value reach the soft ceiling. */
const atCeiling = (b: Budget): boolean => BigInt(b.used) + BigInt(b.held) >= BigInt(b.softCeiling);

function Spark({ series }: { series: number[] }): React.ReactElement {
  const max = Math.max(...series, 1);
  return (
    <span className="mkt-spark" aria-hidden>
      {series.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }} />)}
    </span>
  );
}

/** One sentence on pace: will the budget last to the epoch's end at the rate so far? */
function pace(b: Budget, s: Subscription, nowMs: number): { tone: 'warn' | 'quiet'; key: CopyKey; hours?: number } {
  const total = Math.max(1, s.endsAt - s.startsAt);
  const elapsed = Math.min(total, Math.max(1, nowMs / 1000 - s.startsAt));
  const spent = pctOf(BigInt(b.used) + BigInt(b.held), b.value) / 100;
  if (spent > 0 && spent / (elapsed / total) > 1.15) {
    const runsOutIn = elapsed / spent - elapsed;
    const short = Math.max(1, Math.round((total - elapsed - runsOutIn) / 3_600));
    return { tone: 'warn', key: 'meter.pace.warn', hours: short };
  }
  return { tone: 'quiet', key: 'meter.pace.ok' };
}

export function Meters({ subscription: s, catalog, plan, calls, onTopUp, nowMs = Date.now() }: {
  subscription: Subscription; catalog: CatalogAnswer; plan: Plan | null; calls: Call[]; onTopUp: (serviceId: string) => void; nowMs?: number;
}): React.ReactElement {
  const label = (id: string) => modelName(catalog.services.find((x) => x.serviceId === id)?.label ?? id);
  const value = sumWei(s.budgets.map((b) => b.value));
  const landed = pctOf(sumWei(s.budgets.map((b) => b.used)), value);
  const held = pctOf(sumWei(s.budgets.map((b) => b.held)), value);
  const sparks = useMemo(() => {
    const out: Record<string, number[]> = {};
    const span = Math.max(1, s.endsAt - s.startsAt);
    for (const b of s.budgets) out[b.serviceId] = [0, 0, 0, 0, 0, 0, 0];
    for (const c of calls) {
      const i = Math.min(6, Math.max(0, Math.floor(((c.at - s.startsAt) / span) * 7)));
      if (out[c.serviceId]) out[c.serviceId][i] += c.units;
    }
    return out;
  }, [s, calls]);

  return (
    <div className="ds-card mkt-card" data-testid="mkt-subscription" data-epoch={s.epoch}>
      <div className="mkt-planhead">
        <h1 data-copy="meter.summary">{copy('meter.summary', { n: s.epoch, pct: Math.round(landed), held: Math.round(held) })}</h1>
        <span className="mkt-sec" data-copy="meter.resets">{copy('meter.resets', { t: relAt(s.endsAt, nowMs) })}</span>
      </div>
      <p className="mkt-muted mkt-xs" data-copy="meter.summary.note">{copy('meter.summary.note', { value: fmtTrac(value), cost: fmtTrac(s.cost) })}</p>
      {s.budgets.map((b) => {
        const usedPct = pctOf(b.used, b.value);
        const heldPct = pctOf(b.held, b.value);
        const leftPct = Math.max(0, Math.round(100 - usedPct - heldPct));
        const hit = atCeiling(b);
        const pinned = plan?.services.find((p) => p.serviceId === b.serviceId)?.pinnedSeller;
        const p = pace(b, s, nowMs);
        const others = s.budgets.filter((x) => x.serviceId !== b.serviceId && !atCeiling(x));
        return (
          <div key={b.budgetIndex} className="mkt-mrow" data-testid={`mkt-meter-${b.serviceId}`} data-state={hit ? 'ceiling' : 'active'}>
            <div className="mkt-mhead">
              <span data-copy="meter.line">
                <strong title={b.serviceId} data-copy="_data">{label(b.serviceId)}</strong>{' '}
                <span className="mkt-muted mkt-xs" data-copy={pinned !== undefined ? 'meter.pinned' : 'meter.routed'}>{pinned !== undefined ? copy('meter.pinned', { seller: sellerName(pinned) }) : copy('meter.routed')}</span>
                {' — '}{copy('meter.line', { landed: Math.round(usedPct), held: Math.round(heldPct) })}
              </span>
              <span className="mkt-mono mkt-sec" data-copy="chip.left">{copy('chip.left', { pct: leftPct })}</span>
            </div>
            <div className={`mkt-bar${hit ? ' hit' : usedPct + heldPct >= 85 ? ' warn' : ''}`} role="img" aria-label={copy('meter.bar', { landed: Math.round(usedPct), held: Math.round(heldPct) })}>
              <i style={{ width: `${Math.min(100, usedPct)}%` }} />
              <i className="held" style={{ width: `${Math.min(100 - Math.min(100, usedPct), heldPct)}%` }} />
              <b className="mark" style={{ left: '95%' }} />
            </div>
            <div className="mkt-muted mkt-xs" data-copy="meter.amounts">
              {copy('meter.amounts', { used: fmtTrac(b.used), held: fmtTrac(b.held), left: fmtTrac(freeOf(b)), value: fmtTrac(b.value) })}
              {' · '}{copy('meter.units', { n: fmtCount(unitsOf(freeOf(b), b.maxPricePerUnit)), price: fmtMicro(b.maxPricePerUnit) })}
            </div>
            {hit ? (
              <div className="mkt-fork">
                <div className="mkt-xs" data-copy="meter.hit.title">{copy('meter.hit.title')}</div>
                <button type="button" className="ds-btn ds-primary" data-testid={`mkt-topup-${b.serviceId}`} data-copy="fork.topup" onClick={() => onTopUp(b.serviceId)}>{copy('fork.topup')}</button>
                <span className="mkt-sec mkt-sm" data-copy="meter.hit.wait">
                  {copy('meter.hit.wait', { t: relAt(s.endsAt, nowMs) })}{others.length ? ` ${copy('meter.hit.switch', { alt: label(others[0].serviceId), pct: Math.round(100 - pctOf(BigInt(others[0].used) + BigInt(others[0].held), others[0].value)) })}` : ''}
                </span>
              </div>
            ) : (
              <div className="mkt-sparkrow">
                <Spark series={sparks[b.serviceId] ?? []} />
                <span className={`mkt-pace ${p.tone}`} data-copy={p.key}>{copy(p.key, { h: p.hours ?? 0 })}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
