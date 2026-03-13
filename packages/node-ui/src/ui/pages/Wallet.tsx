import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, PieChart, Pie, Cell,
} from 'recharts';
import { useFetch, shortId } from '../hooks.js';
import { fetchWalletsBalances, fetchRpcHealth, fetchEconomics, fetchStatus, type SpendingPeriod } from '../api.js';

type Tab = 'overview' | 'spending' | 'projections';

export function WalletPage() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div>
      <h1 className="page-title">Node Economics</h1>

      <div className="tab-group">
        <button className={`tab-item ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          Balance & Wallets
        </button>
        <button className={`tab-item ${tab === 'spending' ? 'active' : ''}`} onClick={() => setTab('spending')}>
          Spending
        </button>
        <button className={`tab-item ${tab === 'projections' ? 'active' : ''}`} onClick={() => setTab('projections')}>
          Projections & Savings
        </button>
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'spending' && <SpendingTab />}
      {tab === 'projections' && <ProjectionsTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview Tab                                                       */
/* ------------------------------------------------------------------ */

function OverviewTab() {
  const { data: balancesData } = useFetch(fetchWalletsBalances, [], 15_000);
  const { data: rpcHealth } = useFetch(fetchRpcHealth, [], 10_000);
  const { data: statusData } = useFetch(fetchStatus, [], 30_000);

  const balances = balancesData?.balances ?? [];
  const chainId = balancesData?.chainId ?? null;
  const rpcUrl = balancesData?.rpcUrl ?? rpcHealth?.rpcUrl ?? null;
  const symbol = balancesData?.symbol ?? 'TRAC';
  const error = balancesData?.error ?? rpcHealth?.error;
  const nodeRole: string = statusData?.nodeRole ?? 'edge';

  const totals = useMemo(() => {
    let eth = 0, trac = 0;
    for (const b of balances) {
      eth += parseFloat(b.eth) || 0;
      trac += parseFloat(b.trac) || 0;
    }
    return { eth, trac };
  }, [balances]);

  return (
    <div>
      {error && (
        <div className="card" style={{ borderColor: 'var(--warning)', marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--warning)' }}>Notice</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>{error}</p>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total ETH</div>
          <div className="stat-value">{totals.eth.toFixed(6)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total {symbol}</div>
          <div className="stat-value">{totals.trac.toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Node Role</div>
          <div className={`stat-value ${nodeRole === 'core' ? 'success' : ''}`}>
            {nodeRole.charAt(0).toUpperCase() + nodeRole.slice(1)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">RPC Status</div>
          <div className={`stat-value ${rpcHealth?.ok ? 'success' : 'warning'}`}>
            {rpcHealth?.ok ? 'Healthy' : rpcHealth?.error ? 'Error' : '—'}
            {rpcHealth?.latencyMs != null && <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 6 }}>{rpcHealth.latencyMs}ms</span>}
          </div>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="stat-card">
          <div className="stat-label">Chain ID</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{chainId ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Block #</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{rpcHealth?.blockNumber ?? '—'}</div>
        </div>
      </div>

      {/* Wallet breakdown */}
      <div className="card">
        <div className="card-title">Operational Wallets</div>
        {balances.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
            </div>
            <div className="empty-state-title">No wallets found</div>
            <div className="empty-state-desc">Configure a blockchain connection in your node settings to see wallet balances.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Address</th><th style={{ textAlign: 'right' }}>ETH</th><th style={{ textAlign: 'right' }}>{symbol}</th></tr>
            </thead>
            <tbody>
              {balances.map((b: any) => (
                <tr key={b.address}>
                  <td className="mono" title={b.address}>{shortId(b.address, 10)}</td>
                  <td style={{ textAlign: 'right' }}>{parseFloat(b.eth).toFixed(6)}</td>
                  <td style={{ textAlign: 'right' }}>{parseFloat(b.trac).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Fund these addresses with ETH (gas) and {symbol} (staking/publishing). Managed in ~/.dkg/wallets.json.
        </p>
      </div>

      <div className="card">
        <div className="card-title">RPC Endpoint</div>
        <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{rpcUrl ?? 'Not configured'}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Spending Tab                                                       */
/* ------------------------------------------------------------------ */

const PERIOD_COLORS: Record<string, string> = {
  '24h': '#3b82f6',
  '7d': '#8b5cf6',
  '30d': '#f59e0b',
  'all': '#22c55e',
};

function SpendingTab() {
  const { data: balancesData } = useFetch(fetchWalletsBalances, [], 30_000);
  const { data: economicsData, loading } = useFetch(fetchEconomics, [], 15_000);

  const symbol = balancesData?.symbol ?? 'TRAC';
  const periods: SpendingPeriod[] = economicsData?.periods ?? [];

  const allTime = periods.find(p => p.label === 'all');
  const last24h = periods.find(p => p.label === '24h');
  const last7d = periods.find(p => p.label === '7d');

  const barData = useMemo(() =>
    periods.map(p => ({
      label: p.label,
      gasEth: p.totalGasEth,
      trac: p.totalTrac,
      publishes: p.publishCount,
    })),
    [periods],
  );

  const pieData = useMemo(() => {
    if (!allTime || (allTime.totalGasEth === 0 && allTime.totalTrac === 0)) return [];
    return [
      { name: 'Gas (ETH value)', value: allTime.totalGasEth, color: '#3b82f6' },
      { name: `${symbol} Cost`, value: allTime.totalTrac, color: '#f59e0b' },
    ].filter(d => d.value > 0);
  }, [allTime, symbol]);

  if (loading && !economicsData) return <div className="empty-state">Loading spending data...</div>;

  return (
    <div>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Publishes (24h)</div>
          <div className="stat-value">{last24h?.publishCount ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Gas Spent (24h)</div>
          <div className="stat-value">{fmtEth(last24h?.totalGasEth)} ETH</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{symbol} Spent (24h)</div>
          <div className="stat-value">{fmtTrac(last24h?.totalTrac)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg Gas / Publish</div>
          <div className="stat-value">{fmtEth(last24h?.avgGasEth)} ETH</div>
        </div>
      </div>

      {/* Period comparison table */}
      <div className="card">
        <div className="card-title">Spending by Period</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th style={{ textAlign: 'right' }}>Publishes</th>
              <th style={{ textAlign: 'right' }}>Success</th>
              <th style={{ textAlign: 'right' }}>Total Gas (ETH)</th>
              <th style={{ textAlign: 'right' }}>Total {symbol}</th>
              <th style={{ textAlign: 'right' }}>Avg Gas / Publish</th>
              <th style={{ textAlign: 'right' }}>Avg {symbol} / Publish</th>
            </tr>
          </thead>
          <tbody>
            {periods.map(p => (
              <tr key={p.label}>
                <td><span className="badge" style={{ background: PERIOD_COLORS[p.label] ?? 'var(--accent)' }}>{p.label}</span></td>
                <td style={{ textAlign: 'right' }}>{p.publishCount}</td>
                <td style={{ textAlign: 'right' }}>{p.successCount}</td>
                <td style={{ textAlign: 'right' }}>{fmtEth(p.totalGasEth)}</td>
                <td style={{ textAlign: 'right' }}>{fmtTrac(p.totalTrac)}</td>
                <td style={{ textAlign: 'right' }}>{fmtEth(p.avgGasEth)}</td>
                <td style={{ textAlign: 'right' }}>{fmtTrac(p.avgTrac)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bar chart: total spending per period */}
      {barData.length > 0 && (
        <div className="card">
          <div className="card-title">Total Gas Cost by Period</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={12} />
              <YAxis stroke="var(--text-muted)" fontSize={11} tickFormatter={v => fmtEth(v)} />
              <RechartsTooltip
                contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text)', fontWeight: 600 }}
                formatter={(v: number, name: string) => [name === 'gasEth' ? `${fmtEth(v)} ETH` : fmtTrac(v), name === 'gasEth' ? 'Gas Cost' : symbol]}
              />
              <Bar dataKey="gasEth" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Gas (ETH)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Pie chart: cost breakdown */}
      {pieData.length > 0 && (
        <div className="card">
          <div className="card-title">Cost Breakdown (All Time)</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
            <ResponsiveContainer width="50%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={4}>
                  {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <RechartsTooltip
                  contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8 }}
                  formatter={(v: number, name: string) => [name.includes('Gas') ? `${fmtEth(v)} ETH` : `${fmtTrac(v)} ${symbol}`, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div>
              {pieData.map(d => (
                <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 3, background: d.color }} />
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{d.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Projections & Savings Tab                                          */
/* ------------------------------------------------------------------ */

function ProjectionsTab() {
  const { data: balancesData } = useFetch(fetchWalletsBalances, [], 30_000);
  const { data: economicsData } = useFetch(fetchEconomics, [], 30_000);
  const { data: statusData } = useFetch(fetchStatus, [], 60_000);

  const [targetKAs, setTargetKAs] = useState(10_000);

  const symbol = balancesData?.symbol ?? 'TRAC';
  const nodeRole: string = statusData?.nodeRole ?? 'edge';

  const totals = useMemo(() => {
    let eth = 0, trac = 0;
    for (const b of (balancesData?.balances ?? [])) {
      eth += parseFloat(b.eth) || 0;
      trac += parseFloat(b.trac) || 0;
    }
    return { eth, trac };
  }, [balancesData]);

  const allTime = (economicsData?.periods ?? []).find((p: SpendingPeriod) => p.label === 'all');
  const last7d = (economicsData?.periods ?? []).find((p: SpendingPeriod) => p.label === '7d');

  const avgGasPerPublish = allTime && allTime.publishCount > 0 ? allTime.totalGasEth / allTime.publishCount : 0.0005;
  const avgTracPerPublish = allTime && allTime.publishCount > 0 ? allTime.totalTrac / allTime.publishCount : 50;

  const estimatedKAsWithBalance = useMemo(() => {
    if (avgGasPerPublish <= 0 && avgTracPerPublish <= 0) return Infinity;
    const byGas = avgGasPerPublish > 0 ? Math.floor(totals.eth / avgGasPerPublish) : Infinity;
    const byTrac = avgTracPerPublish > 0 ? Math.floor(totals.trac / avgTracPerPublish) : Infinity;
    return Math.min(byGas, byTrac);
  }, [totals, avgGasPerPublish, avgTracPerPublish]);

  const limitingFactor = useMemo(() => {
    if (avgGasPerPublish <= 0 || avgTracPerPublish <= 0) return 'unknown';
    const byGas = totals.eth / avgGasPerPublish;
    const byTrac = totals.trac / avgTracPerPublish;
    return byGas < byTrac ? 'ETH (gas)' : symbol;
  }, [totals, avgGasPerPublish, avgTracPerPublish, symbol]);

  const costFor = useMemo(() => {
    const ethNeeded = targetKAs * avgGasPerPublish;
    const tracNeeded = targetKAs * avgTracPerPublish;
    const ethShortfall = Math.max(0, ethNeeded - totals.eth);
    const tracShortfall = Math.max(0, tracNeeded - totals.trac);
    return { ethNeeded, tracNeeded, ethShortfall, tracShortfall };
  }, [targetKAs, totals, avgGasPerPublish, avgTracPerPublish]);

  const burnRateDaily = useMemo(() => {
    if (!last7d || last7d.publishCount === 0) return null;
    const daysInPeriod = 7;
    return {
      gasPerDay: last7d.totalGasEth / daysInPeriod,
      tracPerDay: last7d.totalTrac / daysInPeriod,
      publishesPerDay: last7d.publishCount / daysInPeriod,
    };
  }, [last7d]);

  const daysRemaining = useMemo(() => {
    if (!burnRateDaily) return null;
    const byGas = burnRateDaily.gasPerDay > 0 ? totals.eth / burnRateDaily.gasPerDay : Infinity;
    const byTrac = burnRateDaily.tracPerDay > 0 ? totals.trac / burnRateDaily.tracPerDay : Infinity;
    return Math.floor(Math.min(byGas, byTrac));
  }, [burnRateDaily, totals]);

  const runwayChartData = useMemo(() => {
    if (!burnRateDaily) return [];
    const points = [];
    let eth = totals.eth;
    let trac = totals.trac;
    for (let day = 0; day <= 90; day++) {
      points.push({ day, eth: Math.max(0, eth), trac: Math.max(0, trac) });
      eth -= burnRateDaily.gasPerDay;
      trac -= burnRateDaily.tracPerDay;
      if (eth <= 0 && trac <= 0) break;
    }
    return points;
  }, [totals, burnRateDaily]);

  return (
    <div>
      {/* Capacity estimation */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Estimated KAs Publishable</div>
          <div className="stat-value" style={{ color: estimatedKAsWithBalance < 10 ? 'var(--error)' : estimatedKAsWithBalance < 100 ? 'var(--warning)' : 'var(--success)' }}>
            {estimatedKAsWithBalance === Infinity ? '—' : estimatedKAsWithBalance.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>with current balance</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Limiting Factor</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{limitingFactor}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg Gas / Publish</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{fmtEth(avgGasPerPublish)} ETH</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg {symbol} / Publish</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{fmtTrac(avgTracPerPublish)}</div>
        </div>
      </div>

      {/* Runway */}
      {daysRemaining !== null && (
        <div className="card">
          <div className="card-title">Balance Runway</div>
          <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Days Remaining</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: daysRemaining < 7 ? 'var(--error)' : daysRemaining < 30 ? 'var(--warning)' : 'var(--success)' }}>
                {daysRemaining === Infinity ? '∞' : daysRemaining}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Daily Burn (Gas)</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{fmtEth(burnRateDaily?.gasPerDay)} ETH</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Daily Burn ({symbol})</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{fmtTrac(burnRateDaily?.tracPerDay)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Publishes / Day</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{burnRateDaily?.publishesPerDay?.toFixed(1) ?? '—'}</div>
            </div>
          </div>

          {runwayChartData.length > 1 && (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={runwayChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-muted)" fontSize={11} label={{ value: 'Days', position: 'insideBottom', offset: -2, fontSize: 11 }} />
                <YAxis stroke="var(--text-muted)" fontSize={11} />
                <RechartsTooltip
                  contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8 }}
                  formatter={(v: number, name: string) => [name === 'eth' ? `${v.toFixed(6)} ETH` : `${v.toFixed(2)} ${symbol}`, name === 'eth' ? 'ETH Balance' : `${symbol} Balance`]}
                />
                <Area type="monotone" dataKey="eth" stroke="#3b82f6" fill="#3b82f620" name="ETH" />
                <Area type="monotone" dataKey="trac" stroke="#f59e0b" fill="#f59e0b20" name={symbol} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            Projection based on 7-day average spending rate. Actual usage may vary.
          </p>
        </div>
      )}

      {/* Cost calculator */}
      <div className="card">
        <div className="card-title">Cost Calculator</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Target Knowledge Assets:</label>
          <input
            type="number"
            value={targetKAs}
            onChange={e => setTargetKAs(Math.max(1, parseInt(e.target.value) || 1))}
            style={{
              width: 120, padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
              background: 'var(--bg)', color: 'var(--text)', fontSize: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {[100, 1000, 10000, 100000].map(n => (
              <button key={n} onClick={() => setTargetKAs(n)} className="range-pill" style={{ padding: '4px 10px', fontSize: 11 }}>
                {n >= 1000 ? `${n / 1000}k` : n}
              </button>
            ))}
          </div>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Resource</th>
              <th style={{ textAlign: 'right' }}>Needed</th>
              <th style={{ textAlign: 'right' }}>Current Balance</th>
              <th style={{ textAlign: 'right' }}>Shortfall</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>ETH (gas)</td>
              <td style={{ textAlign: 'right' }}>{costFor.ethNeeded.toFixed(6)}</td>
              <td style={{ textAlign: 'right' }}>{totals.eth.toFixed(6)}</td>
              <td style={{ textAlign: 'right', color: costFor.ethShortfall > 0 ? 'var(--error)' : 'var(--success)' }}>
                {costFor.ethShortfall > 0 ? `-${costFor.ethShortfall.toFixed(6)}` : 'Sufficient'}
              </td>
            </tr>
            <tr>
              <td>{symbol}</td>
              <td style={{ textAlign: 'right' }}>{fmtTrac(costFor.tracNeeded)}</td>
              <td style={{ textAlign: 'right' }}>{fmtTrac(totals.trac)}</td>
              <td style={{ textAlign: 'right', color: costFor.tracShortfall > 0 ? 'var(--error)' : 'var(--success)' }}>
                {costFor.tracShortfall > 0 ? `-${fmtTrac(costFor.tracShortfall)}` : 'Sufficient'}
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          Estimates based on average cost per publish across all historical operations.
          {allTime?.publishCount === 0 && ' No publish data yet — estimates use fallback defaults.'}
        </p>
      </div>

      {/* Core node promotion */}
      <CoreNodeCTA nodeRole={nodeRole} symbol={symbol} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Core Node CTA                                                      */
/* ------------------------------------------------------------------ */

function CoreNodeCTA({ nodeRole, symbol }: { nodeRole: string; symbol: string }) {
  const isCore = nodeRole === 'core';

  return (
    <div className="card" style={{ borderColor: isCore ? 'var(--success)' : 'var(--accent)', borderWidth: 2 }}>
      <div className="card-title" style={{ fontSize: 16 }}>
        {isCore ? 'You are running a Core Node' : 'Reduce Costs — Become a Core Node'}
      </div>

      {isCore ? (
        <div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            As a Core Node, you are eligible to earn {symbol} rewards from the network. You can offset your publishing costs
            by staking {symbol} and serving knowledge assets to other nodes.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
            <EarningCard
              title="Serve Knowledge Assets"
              description={`Earn ${symbol} rewards by hosting and serving published knowledge assets to the network. More assets stored = more rewards.`}
              icon="📦"
            />
            <EarningCard
              title="Stake & Delegate"
              description={`Stake your ${symbol} tokens to increase your node's collateral and earning power. You can also attract delegated stake from others.`}
              icon="🔒"
            />
          </div>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
            Edge nodes pay for every publish but cannot earn from the network. Upgrading to a <strong>Core Node</strong> unlocks
            multiple revenue streams that can offset or exceed your publishing costs.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <BenefitCard
              title="Earn Publishing Rewards"
              description={`Core nodes earn ${symbol} for hosting and serving knowledge assets to the network, offsetting your publishing costs.`}
              savings="Offset 50-100% of costs"
            />
            <BenefitCard
              title="Staking Rewards"
              description={`Stake ${symbol} as collateral and earn proportional rewards. Delegated stake from others increases your earning power.`}
              savings="5-15% APY potential"
            />
            <BenefitCard
              title="Lower Publishing Costs"
              description="Core nodes participate in consensus and can publish directly, reducing per-publish overhead and gas costs."
              savings="Lower gas per publish"
            />
            <BenefitCard
              title="Network Participation"
              description="Contribute to the Decentralized Knowledge Graph by storing, validating, and serving knowledge for the network."
              savings="Build reputation"
            />
          </div>

          <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>How to Upgrade</div>
            <ol style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8, margin: 0, paddingLeft: 20 }}>
              <li>Ensure your node has a static IP or domain with open ports (8900 TCP/UDP)</li>
              <li>Set <code style={{ background: 'var(--border)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>nodeRole: "core"</code> in your DKG configuration</li>
              <li>Stake the minimum required {symbol} for your network</li>
              <li>Restart your node — it will begin participating as a Core Node</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function BenefitCard({ title, description, savings }: { title: string; description: string; savings: string }) {
  return (
    <div style={{ background: 'var(--bg)', padding: 14, borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>{description}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--success)' }}>{savings}</div>
    </div>
  );
}

function EarningCard({ title, description, icon }: { title: string; description: string; icon: string }) {
  return (
    <div style={{ background: 'var(--bg)', padding: 14, borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{description}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtEth(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '0';
  if (v === 0) return '0';
  if (v < 0.000001) return v.toExponential(2);
  return v.toFixed(6);
}

function fmtTrac(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '0';
  if (v === 0) return '0';
  return v.toFixed(2);
}

