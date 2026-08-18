// Surface 04 — Playground (spec docs/ui-spec/surfaces/04-playground.md).
// Every message an audited receipt: send goes through THIS node's gateway
// (operator implicit key), the recount runs in the machine path, and the chip
// binds to the leg's real lifecycle state. The receipt drawer is the actual
// leg record — nothing decorative.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { copy, CODE_TO_KEY } from './copy.generated.js';
import {
  StateChip, ProvBadge, ModelLogo, ReceiptDrawer, CostChip, WithholdBody,
  type LegState, type ReceiptLeg,
} from './components.js';
import { DEFAULT_TRAC_USD } from './format.js';
import { authHeaders } from '../http.js';
import { kpiMarkVerified } from './api.js';
import type { CatalogState } from './useCatalog.js';

interface PlayMessage {
  id: number;
  role: 'user' | 'model';
  text: string;
  modelName?: string;
  family?: string;
  state?: LegState;
  leg?: ReceiptLeg;
  withholdCode?: string;
  errKey?: string;      // err.* copy key for failed sends (nothing charged)
}

export function PlaygroundView({ cat, fxRate = DEFAULT_TRAC_USD, initialModel }: {
  cat: CatalogState; fxRate?: number; initialModel?: string;
}): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(initialModel ?? null);
  const [messages, setMessages] = useState<PlayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawerFor, setDrawerFor] = useState<number | null>(null);
  const nextId = useRef(1);

  const models = cat.models;
  const active = useMemo(
    () => models.find((m) => m.groupKey === selected) ?? models[0],
    [models, selected],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !active || busy) return;
    setDraft(''); setBusy(true);
    const uid = nextId.current++;
    const mid = nextId.current++;
    setMessages((ms) => [...ms,
      { id: uid, role: 'user', text },
      { id: mid, role: 'model', text: '', modelName: active.displayName, family: active.family, state: 'checking' },
    ]);
    try {
      // model id on the gateway is the offering modelId — for grouped models
      // pick the first live-quoted provider's variant (router chooses seller)
      const res = await fetch('/marketplace/gateway/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: active.providers[0]?.modelId ?? active.displayName,
          messages: [{ role: 'user', content: text }],
          max_tokens: 512,
          stream: true,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      let body: Record<string, unknown> & { nsm?: { leg?: Record<string, unknown> }; error?: unknown; code?: unknown; legId?: unknown; choices?: Array<{ message?: { content?: string } }> };
      if (res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream') && res.body) {
        // frames render as they arrive; the ✓ lands only after the gateway's
        // final recount event — timing honest, not decorative (spec 04)
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let final: typeof body = {};
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const data = event.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
            if (!data || data === '[DONE]') continue;
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
            if (typeof obj.frame === 'string') {
              const chunk = decodeBase64Utf8(obj.frame);
              setMessages((ms) => ms.map((m) => m.id === mid ? { ...m, text: m.text + chunk } : m));
            } else if (obj.final) {
              final = obj.final as typeof body;
            } else if (obj.error) {
              final = obj as typeof body;
            }
          }
        }
        body = final;
      } else {
        body = await res.json().catch(() => ({}));
      }
      if (body.nsm?.leg) {
        const leg = body.nsm.leg as Record<string, unknown>;
        const meter = leg.meter as { inputTokens: number; outputTokens: number };
        const pricing = leg.pricing as { costMicroTrac: number; perInputTokenMicroTrac?: number; perOutputTokenMicroTrac?: number };
        const evidence = leg.evidence as { deliveredResponseBytesDigest?: string } | undefined;
        const rl: ReceiptLeg = {
          legId: String(leg.legId), state: 'verified',
          costMicro: pricing.costMicroTrac,
          counts: { claimedIn: meter.inputTokens, claimedOut: meter.outputTokens, ourIn: meter.inputTokens, ourOut: meter.outputTokens },
          priceIn: pricing.perInputTokenMicroTrac, priceOut: pricing.perOutputTokenMicroTrac,
          bytesDigest: evidence?.deliveredResponseBytesDigest,
          sellerSig: typeof leg.providerSig === 'string' ? leg.providerSig : undefined,
        };
        const content = String(body.choices?.[0]?.message?.content ?? '');
        setMessages((ms) => ms.map((m) => m.id === mid
          ? { ...m, text: content, state: 'verified', leg: rl }
          : m));
        kpiMarkVerified();
      } else if (body.error === 'E_LEG_WITHHELD') {
        setMessages((ms) => ms.map((m) => m.id === mid
          ? {
              ...m, state: 'blocked', withholdCode: String(body.code),
              text: '',
              leg: { legId: String(body.legId ?? ''), state: 'blocked', costMicro: 0, withholdCode: String(body.code) },
            }
          : m));
      } else {
        const code = String(body.error ?? '');
        const errKey = res.status === 402 || code === 'E_402' || code === 'E_BUDGET'
          ? (code === 'E_BUDGET' ? 'err.402.budget' : 'err.402.unfunded')
          : res.status === 401 ? 'err.401'
          : res.status === 429 ? 'err.429'
          : 'err.5xx';
        setMessages((ms) => ms.map((m) => m.id === mid ? { ...m, errKey, state: undefined } : m));
      }
    } catch {
      setMessages((ms) => ms.map((m) => m.id === mid ? { ...m, errKey: 'err.offline', state: undefined } : m));
    } finally {
      setBusy(false);
    }
  }, [draft, active, busy]);

  return (
    <div className="play">
      <div className="card rail" style={{ padding: 'var(--sp-2)' }}>
        {models.length === 0 && <div className="sec sm" style={{ padding: 'var(--sp-2)' }}>{copy('empty.catalog')}</div>}
        {models.map((m) => (
          <div key={m.groupKey} className={`item${(active?.groupKey === m.groupKey) ? ' is-active' : ''}`}
            onClick={() => setSelected(m.groupKey)} role="button" tabIndex={0}>
            <ModelLogo family={m.family} displayName={m.displayName} size="sm" /> {m.displayName}
            {[...new Set(m.providers.map((p) => p.class))].map((c) => <ProvBadge key={c} cls={c} />)}
          </div>
        ))}
      </div>

      <div className="card card--pad chat">
        {messages.length === 0 && <div className="sec sm">{copy('empty.activity')}</div>}
        {messages.map((m) => m.role === 'user' ? (
          <div key={m.id} className="bubble bubble--user">{m.text}</div>
        ) : (
          <div key={m.id} className="bubble bubble--model">
            <div className="row sm sec" style={{ marginBottom: 'var(--sp-2)' }}>
              {m.family && <ModelLogo family={m.family} displayName={m.modelName ?? ''} size="sm" />} {m.modelName}
            </div>
            {m.errKey ? (
              <div className="sec">{copy(m.errKey)}</div>
            ) : (
              <>
                {m.text && <div>{m.text}</div>}
                {m.state === 'checking' && (
                  <div className="stream-note">▁▂▃ {copy('play.stream.note')}</div>
                )}
                <div className="msg-footer">
                  {m.leg && m.leg.costMicro > 0 && (
                    <CostChip micro={m.leg.costMicro} fxRate={fxRate}
                      onClick={() => setDrawerFor(drawerFor === m.id ? null : m.id)} />
                  )}
                  {m.state && (
                    <span onClick={() => setDrawerFor(drawerFor === m.id ? null : m.id)} style={{ cursor: 'pointer' }}>
                      <StateChip state={m.state} short={m.state !== 'verified'} />
                    </span>
                  )}
                </div>
                {m.state === 'blocked' && m.withholdCode && CODE_TO_KEY[m.withholdCode] && (
                  <WithholdBody code={m.withholdCode} />
                )}
                {drawerFor === m.id && m.leg && (
                  <div style={{ marginTop: 'var(--sp-3)', maxWidth: 'calc(var(--card-min-w) * 1.4)' }}>
                    <ReceiptDrawer leg={m.leg} fxRate={fxRate} />
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        <div className="composer">
          <input className="input" placeholder={copy('play.composer')} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
          <button className="btn btn--primary" onClick={() => void send()} disabled={busy || !active}>{copy('ctl.send')}</button>
        </div>
      </div>
    </div>
  );
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
