import React, { useState } from 'react';

export type MemoryRecord = {
  id: string; turnId?: string; itemId?: string; role: string; phase?: string;
  status: string; error?: string; contextGraphId: string; entityUri?: string; assertionName?: string;
  surface: string; createdAt: string; stats?: { newEntities: number; messageEntities: number;
    conversationEntities: number; traceEntities: number; existingEntitiesConnected: number;
    evidenceEntitiesConnected: number; triples: number; assets: { WM: number; SWM: number; VM: number } };
  recall?: { status: string; hits: any[]; searched: any[]; errors: string[]; durationMs: number; contextChars?: number };
  trace?: { label: string; status: string }[];
};
export type MemoryData = { settings: Record<string, any> | null; records: MemoryRecord[]; recentNative?: MemoryRecord[] };

export function MemoryReceipt({ record }: { record: MemoryRecord }) {
  const s = record.stats;
  return <details className={`codex-memory-receipt ${record.status === 'stored' ? '' : 'pending'}`}>
    <summary><span>{record.status === 'stored' ? '◇' : '◷'} {record.status === 'stored' && s
      ? `+${s.newEntities} entities · ${s.existingEntitiesConnected} existing linked · ${s.assets.WM} WM asset · ${s.assets.SWM} SWM · ${s.assets.VM} VM`
      : 'Private memory queued · not yet stored in DKG'}</span><small>{record.recall?.hits.length || 0} recalled</small></summary>
    <div className="codex-memory-detail">
      <p>Private local Context Graph: <code>{record.contextGraphId}</code></p>
      {s && <p>{s.messageEntities} message + {s.conversationEntities} conversation + {s.traceEntities} action nodes. {s.triples} triples in this message asset. {s.evidenceEntitiesConnected} links to retrieved evidence. These counts describe stored graph structure, not extracted factual claims.</p>}
      {record.entityUri && <p>Message: <code>{record.entityUri}</code></p>}
      {record.assertionName && <p>Asset: <code>{record.assertionName}</code></p>}
      {record.error && <p role="alert">{record.error}. The local queue retries automatically.</p>}
      {record.recall && <details><summary>Context supplied to Codex · {record.recall.status} · {record.recall.durationMs} ms</summary>
        <p>{record.recall.searched.length} graph/layer queries · {record.recall.contextChars || 0} evidence characters. Keyword retrieval; storage layer does not guarantee factual correctness.</p>
        {record.recall.hits.map((h, i) => <article className="codex-memory-hit" key={`${h.entityUri}-${i}`}><strong>{h.contextGraphId} · {h.layer}</strong><code>{h.entityUri}</code><p>{h.text}</p><small>Matched: {h.matchedKeywords?.join(', ')}</small></article>)}
        {!record.recall.hits.length && <p>No relevant evidence was supplied.</p>}
        {!!record.recall.errors.length && <p>{record.recall.errors.join('; ')}</p>}
      </details>}
      <details><summary>Action trace · {record.trace?.length || 0} tools</summary>
        <ol><li>Question → DKG retrieval ({record.recall?.status || 'not requested'})</li>
          <li>Message → private Working Memory ({record.status})</li>
          {record.trace?.map((step, i) => <li key={i}>{step.label} · {step.status}</li>)}
          {record.role === 'assistant' && <li>Reply → private Working Memory ({record.status})</li>}
        </ol><p>Observable actions and evidence; internal reasoning is not recorded.</p>
      </details>
    </div>
  </details>;
}

export function MemorySettings({ data, save, retry }: { data: MemoryData; save: (settings: any) => Promise<void>; retry: () => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<string | null>(null);
  const settings = data.settings;
  if (!settings) return null;
  const update = async (patch: any) => { setBusy(true); setError(''); try { await save(patch); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const pending = data.records.filter((r) => r.status !== 'stored').length;
  return <details className="codex-memory-settings"><summary>◇ DKG memory <small>Private · {pending ? `${pending} queued` : 'Settings & scope'}</small></summary>
    <div className="codex-memory-settings-body"><p>Messages are saved locally in <strong>{settings.contextGraphId}</strong>. Automatic capture does not share or publish them.</p>
      <table><thead><tr><th>Interface</th><th>Save messages</th><th>Retrieve context</th></tr></thead><tbody>
        {['dkg', 'native'].map((surface) => <tr key={surface}><td>{surface === 'dkg' ? 'DKG + Codex' : 'Native Codex'}</td>{['Capture', 'Recall'].map((kind) => <td key={kind}><input aria-label={`${surface} ${kind}`} type="checkbox" checked={settings[surface + kind]} disabled={busy} onChange={(e) => void update({ [surface + kind]: e.target.checked })} /></td>)}</tr>)}
      </tbody></table>
      <p>Native Codex uses lifecycle hooks. New or changed hooks must be enabled in Codex’s hook review before these switches take effect. Capture starts with new interactions; older chats are not imported automatically.</p>
      <label><input type="checkbox" checked={settings.searchLocalGraphs} disabled={busy} onChange={(e) => void update({ searchLocalGraphs: e.target.checked })} /> Search other joined or owned local graphs</label>
      <label>Additional graph IDs (one per line)<textarea aria-label="Additional memory graph IDs" rows={2} value={extra ?? settings.extraGraphIds.join('\n')} onChange={(e) => setExtra(e.target.value)} /></label>
      <button disabled={busy || extra === null} onClick={() => void update({ extraGraphIds: extra?.split('\n').map((s) => s.trim()).filter(Boolean) })}>Save search scope</button>
      {pending > 0 && <button disabled={busy} onClick={() => void retry().catch((e) => setError(e.message))}>Retry {pending} queued messages</button>}
      <p>Turning off capture stops future saves and pauses retries for that interface. Existing memory remains. Turning off retrieval stops context injection.</p>
      {!!data.recentNative?.length && <details><summary>Latest native Codex captures</summary>{data.recentNative.map((r) => <div key={r.id}><p>{r.role === 'user' ? 'You' : 'Codex'} · {new Date(r.createdAt).toLocaleString()}</p><MemoryReceipt record={r} /></div>)}</details>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
