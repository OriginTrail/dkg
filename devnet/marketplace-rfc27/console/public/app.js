// OT-RFC-27 marketplace test console — vanilla JS, no build step.
// Every amount is bigint wei; display strings are derived with exact
// integer math (no floating-point money). Talks only to the console server:
//   /node/<n>/api/marketplace/*  (token injected server-side)
//   /chain/*                      (server-side ethers reads + devnet controls)
//   /console/state                (plan policies / offering sets the console sent)
'use strict';

(() => {
  // ───────────────────────────── constants ─────────────────────────────

  const E18 = 10n ** 18n;
  const UINT96 = 1n << 96n;
  const UINT64 = 1n << 64n;
  const REFRESH_MS = 5000;
  const VIEWS = {
    buyer: { node: 2, title: 'Buyer', dot: 'dot-buyer' },
    'seller-a': { node: 1, title: 'Seller A', dot: 'dot-seller-a' },
    'seller-b': { node: 3, title: 'Seller B', dot: 'dot-seller-b' },
  };
  const ROLE_OF_NODE = { 1: 'seller-a', 2: 'buyer', 3: 'seller-b' };
  const SERVICE_TYPES = ['inference', 'query', 'reasoning', 'graph-ml'];
  const UNITS = ['token', 'query-unit'];
  const SERVICE_LABEL = { inference: 'Inference', query: 'SPARQL query', reasoning: 'Reasoning', 'graph-ml': 'Graph ML' };
  const UNIT_LABEL = { token: 'token', 'query-unit': 'query unit' };

  /** Kept in sync with seed.mjs DEFAULT_PLAN. */
  const DEFAULT_PLAN = {
    amountTrac: '0.01',
    buckets: [
      { serviceType: 'inference', modelId: '', budgetTrac: '0.006', capMicro: '1', maxUnits: '16000' },
      { serviceType: 'query', modelId: '', budgetTrac: '0.004', capMicro: '20', maxUnits: '200' },
    ],
  };
  const DEVNET_OFFERINGS = {
    1: [
      { id: 'devnet-llm', serviceType: 'inference', unit: 'token', modelId: '', askMicro: '0.5' },
      { id: 'devnet-knowledge', serviceType: 'query', unit: 'query-unit', modelId: '', askMicro: '15' },
    ],
    3: [{ id: 'devnet-llm', serviceType: 'inference', unit: 'token', modelId: '', askMicro: '0.8' }],
  };
  const SAMPLE_PROMPT = 'Explain in two sentences how an OT-RFC-27 subscription pays sellers: the buyer funds a pool, sellers claim signed receipts, and rewards follow QIF.';
  const SAMPLE_SPARQL = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';

  const REJECTION_WORDS = {
    'soft-ceiling': 'its worst case (max units × ask) would be more than 95% of what is left in the bucket',
    'price-cap': 'its ask is above your price cap',
    'deny-list': 'the seller is on your deny list',
    'allow-list': 'the seller is not on your allow list',
    'no-quote': 'the seller did not answer the live price quote',
    unavailable: 'the seller declined the quote (it no longer serves this offering)',
    capacity: 'the seller’s capacity is below the max units for this call',
    'offer-expired': 'the offer has expired',
    'service-mismatch': 'it is a different service',
    'model-mismatch': 'it is a different model',
  };

  const SELLER_CODES = {
    UNDERFUNDED: 'The seller refused: your on-chain bucket cannot cover this call’s worst case (max units × ask) on top of what is already claimed or waiting to be claimed. Lower the max units or add funds.',
    SETTLEMENT_CLOSED: 'The seller refused: your plan’s epoch has ended. Subscribe again for the current epoch.',
    EXPIRED: 'The authorization expired before the seller saw it (chain time moved — e.g. after time travel). Try again.',
    STALE_AUTHORIZATION: 'The authorization would expire inside the seller’s receipt-batching window. Try again; if chain time was just advanced, wait ~30 s for the nodes to notice.',
    BAD_ASK: 'The seller changed its price since the quote. Try again.',
    UNKNOWN_OFFERING: 'The seller no longer serves this offering.',
    OVER_MAX_UNITS: 'The result needs more units than “Max units for this call” allows — raise it (for inference, the prompt alone is metered).',
    BAD_AUTH: 'The seller could not verify your session-key signature against the key registered on-chain.',
    REPLAYED_CALL_ID: 'The seller has already served this authorization (single-use call id).',
    WRONG_SELLER: 'The authorization was signed for a different seller.',
    BAD_PAYLOAD: 'The seller could not read the request payload.',
    EXECUTION_FAILED: 'The seller failed while executing the call.',
    EMPTY_RESULT: 'The seller produced an empty result (zero units).',
    WRONG_PAYLOAD_KIND: 'The payload kind does not match the seller’s offering.',
    SELLER_NOT_READY: 'The seller node is not ready (identity or chain access missing).',
    NOT_DELIVERED: 'The request never reached the seller (dial failed). Nothing was charged.',
    DELIVERY_UNKNOWN: 'The connection failed mid-call; the seller may have served. The reservation is held until the authorization expires.',
    BAD_RECEIPT: 'The seller’s receipt failed verification — the reservation was settled at the worst case.',
    MALFORMED_RECEIPT: 'The seller’s receipt was malformed — the reservation was settled at the worst case.',
    MALFORMED_RESULT: 'The seller’s result was not valid JSON.',
    UNVERIFIABLE_SELLER: 'The receipt signer could not be resolved to an on-chain identity.',
    NO_MARKETPLACE_ADDRESS: 'The buyer node cannot resolve the Marketplace contract.',
  };

  const REVERT_WORDS = [
    [/SettlementStillOpen/, 'The settlement window is still open — wait for (or time-travel past) the settlement deadline.'],
    [/BucketAlreadyFinalized/, 'This bucket is already finalized.'],
    [/BucketNotFunded/, 'There is no funded bucket for that buyer and epoch.'],
    [/OpenBucketsRemaining/, 'Some buckets of this epoch are not finalized yet — every bucket must be finalized before rewards can be claimed.'],
    [/NothingFinalizedForEpoch/, 'Nothing was finalized in this epoch, so there is no reward to claim.'],
    [/RewardAlreadyClaimed/, 'This node already claimed its reward for the epoch.'],
    [/NotOperationalWallet/, 'The claiming wallet is not an operational wallet of this identity.'],
    [/InvalidSubscriptionEpoch/, 'Subscriptions can only fund the current or the next epoch.'],
    [/ERC20InsufficientBalance|transfer amount exceeds balance/i, 'The funding wallet does not hold enough TRAC.'],
  ];

  // ───────────────────────────── state ─────────────────────────────

  const slot = () => ({ data: null, error: null, at: 0, loaded: false, failedSince: null });
  const S = {
    view: 'buyer',
    chain: slot(),
    nodes: slot(),
    cstate: slot(),
    status: { 1: slot(), 2: slot(), 3: slot() },
    meter: slot(),
    offers: { 1: slot(), 2: slot(), 3: slot() },
    epochs: {},
    viewEpoch: null,
    viewEpochPinned: false,
    busy: {},
    results: {},
    history: [],
    sub: null,
    editors: {},
    pg: { service: 'inference', prompt: SAMPLE_PROMPT, sparql: SAMPLE_SPARQL, maxUnits: { inference: '1000', query: '50' } },
    revealed: new Set(),
    tick: 0,
    refreshing: false,
    refreshQueued: null,
    /** Live asks seen in invoke authorizations: `${offeringId}:${sellerId}` → { ask, at }. */
    observed: {},
    stripOpen: false,
    unloading: false,
  };

  // ───────────────────────────── small utils ─────────────────────────────

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const W = (v) => {
    try {
      if (v === null || v === undefined || v === '') return 0n;
      return BigInt(v);
    } catch {
      return 0n;
    }
  };
  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* storage unavailable */
      }
    },
  };
  const session = {
    get(k) {
      try {
        return JSON.parse(window.sessionStorage.getItem(k) ?? 'null');
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        window.sessionStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
  };

  const groupInt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /** Exact decimal of `v / 10^digits` (bigint), trailing zeros trimmed. */
  function decimal(v, digits) {
    const scale = 10n ** BigInt(digits);
    const neg = v < 0n;
    const a = neg ? -v : v;
    const frac = (a % scale).toString().padStart(digits, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${groupInt((a / scale).toString())}${frac ? `.${frac}` : ''}`;
  }

  /** Rounded (half-up, bigint) decimal with at most `maxFrac` fraction digits; flags rounding. */
  function decimalRounded(v, digits, maxFrac) {
    const exact = decimal(v, digits);
    const frac = exact.split('.')[1] ?? '';
    if (frac.length <= maxFrac) return { text: exact, approx: false };
    const neg = v < 0n;
    const a = neg ? -v : v;
    const drop = 10n ** BigInt(digits - maxFrac);
    let q = a / drop;
    if ((a % drop) * 2n >= drop) q += 1n;
    if (q === 0n) return { text: `<${neg ? '-' : ''}0.${'0'.repeat(maxFrac - 1)}1`, approx: false, tiny: true };
    return { text: `${neg ? '-' : ''}${decimal(q, maxFrac)}`, approx: true };
  }

  const trac = (wei) => decimal(W(wei), 18);

  /**
   * One unit for a whole panel or table column, so decimals line up and
   * shares compare at a glance: µTRAC while every amount in the group is
   * below 1 TRAC (all marketplace amounts on this devnet), TRAC otherwise.
   * Wallet balances are always TRAC and say so.
   */
  function pickUnit(...values) {
    let max = 0n;
    for (const x of values.flat()) {
      const v = W(x);
      const a = v < 0n ? -v : v;
      if (a > max) max = a;
    }
    return max < E18 ? 'micro' : 'trac';
  }

  /**
   * An amount in the given unit (default µTRAC). The exact wei value is in
   * the tooltip, one click deeper, and on every amount with “Exact wei” on.
   * Not a tab stop: keyboard users get exact wei through the header toggle.
   */
  function amt(wei, opts = {}) {
    const v = W(wei);
    const unit = opts.unit ?? 'micro';
    const r = unit === 'micro' ? decimalRounded(v, 12, 6) : decimalRounded(v, 18, 9);
    const unitText = opts.bare ? '' : `${unit === 'micro' ? 'µTRAC' : 'TRAC'}${opts.suffix ?? ''}`;
    const exactTrac = decimal(v, 18);
    const revealed = S.revealed.has(v.toString()) ? ' is-revealed' : '';
    return `<span class="amt${revealed}" data-wei="${v}" title="exact: ${esc(groupInt(v.toString()))} wei = ${esc(exactTrac)} TRAC (click to show)"><span class="amt-n">${esc(`${r.approx ? '≈' : ''}${r.text}`)}</span>${unitText ? ` <span class="amt-u">${esc(unitText)}</span>` : ''}<span class="amt-wei">${esc(groupInt(v.toString()))} wei</span></span>`;
  }

  const UNIT_OF_SERVICE = { inference: 'token', query: 'query-unit' };
  /** An ask, always µTRAC per unit (named when known). */
  const askAmt = (wei, unit) => amt(wei, { unit: 'micro', suffix: unit ? `/${UNIT_LABEL[unit] ?? unit}` : '/unit' });

  /** Parse an exact decimal string with at most `digits` fraction digits into base units. */
  function parseDecimal(str, digits) {
    const s = String(str ?? '').trim().replace(/,/g, '');
    const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
    if (!m) throw new Error('enter a plain decimal number');
    const frac = m[2] ?? '';
    if (frac.length > digits) throw new Error(`at most ${digits} decimals`);
    return BigInt(m[1]) * 10n ** BigInt(digits) + BigInt(frac.padEnd(digits, '0') || '0');
  }
  const parseTrac = (s) => parseDecimal(s, 18);
  const parseMicro = (s) => parseDecimal(s, 12);
  function parseUnits(s) {
    const t = String(s ?? '').trim().replace(/,/g, '');
    if (!/^\d+$/.test(t)) throw new Error('enter a whole number');
    return BigInt(t);
  }

  /** bigint ratio (18-dec fixed) → percent string with `dp` decimals (floor). */
  function pct18(x, dp = 2) {
    const v = W(x) * 100n;
    return `${decimalRounded(v, 18, dp).text}%`;
  }
  function pctOf(part, whole, dp = 1) {
    const p = W(part);
    const w = W(whole);
    if (w === 0n) return '—';
    return pct18((p * E18) / w, dp);
  }
  /** CSS width % (display only, not money). */
  function widthPct(part, whole) {
    const w = W(whole);
    if (w <= 0n) return 0;
    const v = Number((W(part) * 100000n) / w) / 1000;
    return Math.max(0, Math.min(100, v));
  }

  const shortHex = (h, a = 6, b = 4) => {
    const s = String(h ?? '');
    return s.length > a + b + 2 ? `${s.slice(0, a + 2)}…${s.slice(-b)}` : s;
  };

  function fmtDur(totalSeconds) {
    let s = Math.max(0, Math.floor(Number(totalSeconds)));
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
    if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
    if (m > 0) return `${m}m ${pad(s)}s`;
    return `${s}s`;
  }

  function fmtTime(unixSeconds) {
    const n = Number(W(unixSeconds));
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n * 1000);
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }

  function fmtClock(unixSeconds) {
    const d = new Date(Number(unixSeconds) * 1000);
    return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  /** Chain-time estimate (seconds, Number — display/countdown only). */
  function chainNowSec() {
    const c = S.chain.data;
    if (!c) return Math.floor(Date.now() / 1000);
    return Number(W(c.chainTime)) + Math.floor((Date.now() - S.chain.at) / 1000);
  }

  /**
   * A live countdown to chain time `t`. `future` / `past` are whole phrases
   * with `{}` for the duration, e.g. { future: 'deadline in {}', past:
   * 'deadline passed {} ago' } — no fixed prefix outside the span.
   */
  const countdown = (t, { future = 'in {}', past = '{} ago' } = {}) =>
    `<span class="countdown" data-countdown="${esc(W(t).toString())}" data-future="${esc(future)}" data-past="${esc(past)}"></span>`;
  const since = (at, slot) => `<span data-since="${at}"${slot?.data && slot?.error ? ' data-stale="1" class="warn-text"' : ''}></span>`;

  function tokensOf(text) {
    const n = new TextEncoder().encode(String(text ?? '')).length;
    return n === 0 ? 0 : Math.ceil(n / 4);
  }

  // ───────────────────────────── API ─────────────────────────────

  async function api(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const init = { method, signal: ctl.signal, credentials: 'same-origin', cache: 'no-store' };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(path, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON */
      }
      return { ok: res.ok, status: res.status, json, text };
    } catch (e) {
      return { ok: false, status: 0, json: null, text: e?.name === 'AbortError' ? 'request timed out' : String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Load into a slot. On failure the last good `data` stays, `error` is set
   * and `failedSince` remembers when refreshes started failing; `at` is the
   * time of the last SUCCESS, so “updated Ns ago” never pretends stale data
   * is fresh. Panels render staleBanner() when data and error coexist.
   */
  async function load(target, path, opts) {
    const r = await api(path, opts);
    if (r.ok) {
      target.data = r.json;
      target.error = null;
      target.failedSince = null;
      target.at = Date.now();
    } else {
      target.error = r;
      target.failedSince ??= Date.now();
    }
    target.loaded = true;
    return r;
  }

  /** “Refresh failing” banner for panels that still show last-good data. */
  function staleBanner(...slots) {
    const s = slots.find((x) => x?.data && x?.error);
    if (!s) return '';
    const x = explain(s.error);
    return `<div class="state state-warn state-stale" role="status">
      <div class="state-title">Refresh failing <span class="code-chip">${esc(x.code ?? 'ERROR')}</span></div>
      <p>${esc(x.title)} — showing the last good data from <span data-since-plain="${s.at}"></span> ago. Values below may be out of date.
      <button type="button" class="btn btn-sm" data-action="retry">Retry now</button></p>
    </div>`;
  }

  const nodePath = (n, p) => `/node/${n}/api/marketplace${p}`;

  // ───────────────────────────── explanations ─────────────────────────────

  function rejectionLine(rej) {
    const where = offerLabelFromId(rej?.offerId);
    const words = REJECTION_WORDS[rej?.reason] ?? rej?.reason ?? 'rejected';
    return `${where} — ${esc(words)} <span class="code-chip">${esc(rej?.reason ?? '?')}</span>`;
  }

  /**
   * Plain-words explanation of a failed request. `ctx.kind === 'invoke'`
   * marks a call whose outcome may be unknown; `ctx.maxUnitsPerCall` lets
   * the max-units refusal state the actual limit.
   */
  function explain(r, ctx = {}) {
    const j = r?.json ?? {};
    const msg = typeof j?.error === 'string' ? j.error : (r?.text ?? '');
    const out = { title: 'Request failed', body: esc(msg || `HTTP ${r?.status}`), code: j?.code ?? (r?.status ? `HTTP ${r.status}` : null), detail: null, list: null };
    if (r?.local) {
      return { ...out, title: 'Not sent — checked in the browser', body: esc(msg), code: 'LOCAL CHECK' };
    }
    if (r && r.status === 0 && ctx.kind === 'invoke') {
      return {
        ...out,
        title: 'Outcome unknown',
        body: `The console got no answer (${esc(r.text || 'connection lost')}). The buyer node may still have served and charged this call — check the meter in “Your plan & usage meter”.`,
        code: 'NO ANSWER',
        unknown: true,
      };
    }
    if (!r || r.status === 0) {
      return { ...out, title: 'Console server unreachable', body: `The console server did not answer (${esc(r?.text ?? 'network error')}). Is <code>pnpm devnet:marketplace:console</code> still running?`, code: 'OFFLINE' };
    }
    if (r.status === 504 && ctx.kind === 'invoke') {
      return { ...out, title: 'Outcome unknown', body: `${esc(msg)}. The node may still finish and charge this call — check the meter.`, code: 'HTTP 504', unknown: true };
    }
    if (r.status === 401) {
      return { ...out, title: 'Access key required', body: 'Reopen the console link that carries <code>?key=…</code> to restore access.', code: 'HTTP 401' };
    }
    if (j?.code === 'NODE_UNREACHABLE') {
      return { ...out, title: 'Node unreachable', body: `${esc(msg)}. Check <code>./scripts/devnet.sh status</code>.` };
    }
    if (j?.code === 'CHAIN_DOWN') {
      return { ...out, title: 'Chain unreachable', body: `${esc(msg)}. Is the Hardhat node running?` };
    }
    if (r.status === 503) {
      return { ...out, title: 'Marketplace unavailable on this node', body: esc(msg) };
    }
    if (j?.code === 'NOT_SUBSCRIBED') {
      return {
        ...out,
        title: 'No active plan on the buyer node',
        body: 'Subscribe first. (The local plan and meter live in the buyer node’s memory — if the node restarted, subscribe again to restore them; the on-chain bucket keeps its funds.)',
      };
    }
    if (j?.code === 'NO_ROUTE') {
      const reason = j.reason;
      const rejections = Array.isArray(j.rejections) ? j.rejections : [];
      const relevant = rejections.filter((x) => x?.reason !== 'service-mismatch' && x?.reason !== 'model-mismatch');
      const ceiling = relevant.some((x) => x?.reason === 'soft-ceiling');
      let title = 'No seller can take this call';
      let body;
      if (reason === 'no-offers') {
        title = 'No offers discovered yet';
        body = 'The buyer node has not synced any offers from the marketplace context graph. Discovery normally takes seconds after the first seller publish (up to about a minute); each Offers refresh nudges a re-sync.';
      } else if (reason === 'no-bucket') {
        title = 'Your plan has no bucket for this service';
        body = 'Add a bucket for this service type to your plan (Subscribe), then try again.';
      } else if (reason === 'max-units') {
        const limit = ctx.maxUnitsPerCall !== undefined && ctx.maxUnitsPerCall !== null ? groupInt(String(ctx.maxUnitsPerCall)) : null;
        title = 'Max units for this call is above the bucket’s limit';
        body = limit
          ? `This bucket allows at most <strong>${esc(limit)}</strong> units per call. Lower “Max units for this call” to ${esc(limit)} or less, or subscribe with a higher “Max units / call”. Nothing was reserved or charged.`
          : 'Lower “Max units for this call” to at most the bucket’s “Max units / call”, or subscribe with a higher limit. Nothing was reserved or charged.';
      } else if (ceiling) {
        title = 'Soft ceiling reached';
        body = 'Your node refused the call locally: its worst case (max units × ask) would be more than 95% of what is left in this bucket. Nothing was reserved or charged. Lower the max units, or fund a new plan.';
      } else {
        body = 'Offers were found, but your plan rejected every one of them:';
      }
      return {
        ...out,
        title,
        body,
        code: `NO_ROUTE · ${reason ?? '?'}`,
        list: relevant.length ? relevant.map(rejectionLine) : null,
        detail: msg,
      };
    }
    if (r.status === 502 && j?.code) {
      return { ...out, title: 'The seller did not serve this call', body: esc(SELLER_CODES[j.code] ?? 'The selected seller failed the call.'), code: j.code, detail: msg };
    }
    for (const [re, words] of REVERT_WORDS) {
      if (re.test(msg)) return { ...out, title: 'The contract refused', body: esc(words), detail: msg };
    }
    if (r.status === 400) return { ...out, title: 'Request rejected', body: esc(msg) };
    return { ...out, detail: msg.length > 160 ? msg : null, body: esc(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg) };
  }

  // ───────────────────────────── state boxes ─────────────────────────────

  const skeleton = () => '<div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div><span class="visually-hidden">Loading…</span>';

  function errorBox(r, opts = {}) {
    const x = explain(r, opts.ctx);
    return `<div class="state state-error" role="alert">
      <div class="state-title">${esc(opts.title ?? x.title)} ${x.code ? `<span class="code-chip">${esc(x.code)}</span>` : ''}</div>
      <p>${x.body}</p>
      ${x.list ? `<ul>${x.list.map((li) => `<li>${li}</li>`).join('')}</ul>` : ''}
      ${x.detail ? `<details><summary>Raw message</summary><div class="hex">${esc(x.detail)}</div></details>` : ''}
      ${opts.retry ? `<p><button type="button" class="btn btn-sm" data-action="retry">Retry now</button></p>` : ''}
    </div>`;
  }
  // Bodies may hold block HTML (lists, paragraphs), so they go in a <div>.
  const emptyBox = (title, body = '') =>
    `<div class="state state-empty"><div class="state-title">${esc(title)}</div>${body ? `<div class="state-body">${body}</div>` : ''}</div>`;
  const okBox = (title, body = '') =>
    `<div class="state state-ok" role="status"><div class="state-title">${title}</div>${body ? `<div class="state-body">${body}</div>` : ''}</div>`;
  const warnBox = (title, body = '') =>
    `<div class="state state-warn"><div class="state-title">${title}</div>${body ? `<div class="state-body">${body}</div>` : ''}</div>`;
  const infoBox = (title, body = '') =>
    `<div class="state state-info"><div class="state-title">${title}</div>${body ? `<div class="state-body">${body}</div>` : ''}</div>`;

  function toast(html, kind = '') {
    const region = $('#toasts');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast${kind ? ` is-${kind}` : ''}`;
    el.innerHTML = html;
    region.appendChild(el);
    setTimeout(() => el.remove(), 6500);
  }

  // ───────────────────────────── identity helpers ─────────────────────────────

  const nodesList = () => S.nodes.data?.nodes ?? [];
  const nodeInfo = (n) => nodesList().find((x) => x.num === n);
  function nodeOfIdentity(id) {
    const s = W(id).toString();
    return nodesList().find((x) => W(x.identityId) > 0n && W(x.identityId).toString() === s)?.num ?? null;
  }
  function nodeOfAddress(addr) {
    const a = String(addr ?? '').toLowerCase();
    return nodesList().find((x) => (x.opWallets ?? []).some((w) => w.address.toLowerCase() === a))?.num ?? null;
  }
  function nodeName(n) {
    const role = ROLE_OF_NODE[n];
    return role ? `${VIEWS[role].title} · node${n}` : `node${n}`;
  }
  function whoNode(n) {
    const role = ROLE_OF_NODE[n] ?? 'other';
    return `<span class="who"><span class="dot dot-${role}"></span>${esc(nodeName(n))}</span>`;
  }
  function whoIdentity(id) {
    const n = nodeOfIdentity(id);
    const idText = `id ${W(id)}`;
    return n ? `<span class="who"><span class="dot dot-${ROLE_OF_NODE[n] ?? 'other'}"></span>${esc(nodeName(n))} <span class="id">${esc(idText)}</span></span>` : `<span class="who">identity ${esc(W(id).toString())}</span>`;
  }
  function whoAddress(addr) {
    const n = nodeOfAddress(addr);
    return n ? `${whoNode(n)} <span class="hex muted nowrap">${esc(shortHex(addr))}</span>` : `<span class="hex">${esc(addr)}</span>`;
  }
  function localIdOf(offerId) {
    const parts = String(offerId ?? '').split(':');
    return parts.length > 5 && parts[0] === 'urn' ? parts.slice(5).join(':') : '';
  }
  function offerLabelFromId(offerId) {
    const parts = String(offerId ?? '').split(':');
    if (parts.length > 5) {
      const peer = parts[4];
      const node = nodesList().find((x) => x.peerId === peer);
      return `${node ? esc(nodeName(node.num)) : `peer …${esc(peer.slice(-6))}`} <code>${esc(parts.slice(5).join(':'))}</code>`;
    }
    return `<code>${esc(offerId ?? '?')}</code>`;
  }

  // ───────────────────────────── plan / policy helpers ─────────────────────────────

  function buyerStatus() {
    return S.status[2].data ?? null;
  }
  /** The active plan's policy as remembered by the console (labels, caps), when it matches the live meter. */
  function activePlan() {
    const st = buyerStatus();
    if (!st?.buyer?.subscribed) return null;
    const plan = S.cstate.data?.plans?.['2'];
    const meterBuckets = st.buyer.meter?.buckets ?? [];
    if (!plan?.policy || String(plan.epoch) !== String(st.buyer.epoch)) return { policy: null, epoch: String(st.buyer.epoch) };
    if ((plan.policy.buckets ?? []).length !== meterBuckets.length) return { policy: null, epoch: String(st.buyer.epoch) };
    return { policy: plan.policy, epoch: String(st.buyer.epoch), plan };
  }

  /** The draft plan from the Subscribe form → { policy, amountWei, errors }. */
  function draftPlan() {
    const f = S.sub;
    const errors = {};
    let amountWei = 0n;
    try {
      amountWei = parseTrac(f.amountTrac);
      if (amountWei <= 0n) errors.amount = 'must be > 0';
      else if (amountWei >= UINT96) errors.amount = 'too large (uint96)';
    } catch (e) {
      errors.amount = e.message;
    }
    const buckets = f.buckets.map((b, i) => {
      const out = { match: { serviceType: b.serviceType } };
      if (b.modelId.trim()) out.match.modelId = b.modelId.trim();
      try {
        const v = parseTrac(b.budgetTrac);
        if (v <= 0n) throw new Error('must be > 0');
        out.budgetWei = v.toString();
      } catch (e) {
        errors[`b${i}.budget`] = e.message;
      }
      try {
        const v = parseMicro(b.capMicro);
        if (v <= 0n) throw new Error('must be > 0');
        if (v >= UINT96) throw new Error('too large');
        out.priceCapWeiPerUnit = v.toString();
      } catch (e) {
        errors[`b${i}.cap`] = e.message;
      }
      try {
        const v = parseUnits(b.maxUnits);
        if (v <= 0n) throw new Error('must be > 0');
        if (v >= UINT64) throw new Error('too large');
        out.maxUnitsPerCall = v.toString();
      } catch (e) {
        errors[`b${i}.units`] = e.message;
      }
      return out;
    });
    if (buckets.length === 0) errors.buckets = 'add at least one bucket';
    const total = buckets.reduce((s, b) => s + W(b.budgetWei), 0n);
    const policy = {
      totalBudgetWei: total.toString(),
      buckets,
      ...(f.deny.size > 0 ? { sellerDeny: [...f.deny] } : {}),
    };
    return { policy, amountWei, total, errors };
  }

  /**
   * What the SELLER side currently says about one discovered offer. The
   * buyer's discovered ask lags a seller's update by seconds, up to about a
   * minute (an on-chain update of the offer KA), while the router ranks on
   * the live quote, which answers with the seller's currently served ask.
   * Sources, best first:
   *   1. the offering set the console last published to that seller node,
   *      when the node still serves a set of that size — unless that set was
   *      published and the seller node's own graph view now holds a different
   *      ask (the seller was republished outside this console since);
   *   2. the seller node's own view of its offer in the marketplace graph;
   *   3. the ask carried by a live quote this browser saw in an invoke.
   * → { node, liveAsk (bigint|null), served (bool|null), source, stale }
   */
  function sellerSide(o) {
    const n = nodeOfIdentity(o.sellerIdentityId);
    const discovered = W(o.askPerUnitWei);
    const out = { node: n, liveAsk: null, served: null, source: null, stale: false, at: null };
    const localId = localIdOf(o.offerId);
    if (n) {
      const own = (S.offers[n]?.data?.offers ?? []).filter((x) => x.offerId === o.offerId);
      const graphAsk = own.length === 1 ? W(own[0].askPerUnitWei) : null;
      const remembered = S.cstate.data?.offerings?.[String(n)];
      const servedCount = S.status[n]?.data?.seller?.offerings;
      if (remembered?.offerings && servedCount !== undefined && servedCount === remembered.offerings.length) {
        const entry = remembered.offerings.find((x) => x.offeringLocalId === localId);
        out.source = 'console';
        out.at = remembered.at ?? null;
        if (entry) {
          out.served = true;
          out.liveAsk = W(entry.askPerUnitWei);
          if (remembered.publish !== false && graphAsk !== null && graphAsk !== out.liveAsk) {
            out.liveAsk = graphAsk;
            out.source = 'seller-graph';
            out.at = null;
          }
        } else {
          out.served = false;
        }
      }
      if (out.liveAsk === null && out.served === null && graphAsk !== null) {
        out.liveAsk = graphAsk;
        out.source = 'seller-graph';
      }
    }
    if (out.liveAsk === null && out.served === null) {
      const seen = S.observed[`${String(o.offeringId).toLowerCase()}:${W(o.sellerIdentityId)}`];
      if (seen) {
        out.liveAsk = W(seen.ask);
        out.source = 'quote';
        out.at = seen.at;
      }
    }
    out.stale = out.served === false || (out.liveAsk !== null && out.liveAsk !== discovered);
    return out;
  }

  /** The ask the router will most likely see in the live quote. */
  const effectiveAsk = (o, side = sellerSide(o)) => side.liveAsk ?? W(o.askPerUnitWei);

  /**
   * Mirror of the router's filters and ranking, on the best-known LIVE ask
   * (sellerSide), since the real router ranks on live quotes, not on the
   * discovered ask. Quote availability and the soft ceiling still decide at
   * call time.
   */
  function routerPreview(offers, policy) {
    const verdict = new Map();
    const now = chainNowSec();
    const candidates = {};
    for (const o of offers) {
      const key = offerKey(o);
      const side = sellerSide(o);
      const ask = effectiveAsk(o, side);
      if (!policy) {
        verdict.set(key, { why: null, side, ask });
        continue;
      }
      const bucket = (policy.buckets ?? []).find((b) => b.match?.serviceType === o.serviceType && (!b.match?.modelId || b.match.modelId === o.modelId));
      let why = null;
      if (!bucket) why = `no plan bucket for ${SERVICE_LABEL[o.serviceType] ?? o.serviceType}`;
      else if (o.expiresAt && Number(o.expiresAt) <= now) why = 'offer expired';
      else if ((policy.sellerDeny ?? []).map(String).includes(String(o.sellerIdentityId))) why = 'seller on your deny list';
      else if (policy.sellerAllow && !policy.sellerAllow.map(String).includes(String(o.sellerIdentityId))) why = 'seller not on your allow list';
      else if (side.served === false) why = 'the seller no longer serves it (its quote will decline)';
      else if (ask > W(bucket.priceCapWeiPerUnit)) why = 'ask above your price cap';
      if (why) verdict.set(key, { why, side, ask });
      else (candidates[o.serviceType] ??= []).push({ o, side, ask });
    }
    const picks = {};
    for (const [svc, list] of Object.entries(candidates)) {
      list.sort((a, b) => {
        const d = a.ask - b.ask;
        if (d !== 0n) return d < 0n ? -1 : 1;
        return String(a.o.sellerPeerId) < String(b.o.sellerPeerId) ? -1 : 1;
      });
      picks[svc] = { ...list[0].o, liveAskWei: list[0].ask, side: list[0].side };
      list.forEach((c, i) => verdict.set(offerKey(c.o), i === 0 ? { pick: true, side: c.side, ask: c.ask } : { why: 'pricier than the pick', side: c.side, ask: c.ask }));
    }
    return { verdict, picks };
  }
  const offerKey = (o) => `${o.offerId}|${o.askPerUnitWei}|${o.offeringId}`;

  function dedupeOffers(list) {
    const seen = new Set();
    const out = [];
    for (const o of list ?? []) {
      const k = offerKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
    return out.sort((a, b) => String(a.serviceType).localeCompare(String(b.serviceType)) || (W(a.askPerUnitWei) < W(b.askPerUnitWei) ? -1 : 1));
  }

  // ───────────────────────────── epoch selection ─────────────────────────────

  function currentEpoch() {
    return S.chain.data ? W(S.chain.data.epoch) : null;
  }
  function autoEpoch() {
    const st = buyerStatus();
    if (st?.buyer?.epoch !== undefined) return W(st.buyer.epoch);
    const plan = S.cstate.data?.plans?.['2'];
    if (plan?.epoch) return W(plan.epoch);
    const rows = S.chain.data?.epochs ?? [];
    const cur = currentEpoch();
    const funded = rows.filter((r) => W(r.pool) > 0n && W(r.epoch) <= (cur ?? 0n)).map((r) => W(r.epoch));
    if (funded.length) return funded[funded.length - 1];
    return cur;
  }
  function viewEpoch() {
    if (S.viewEpochPinned && S.viewEpoch !== null) return S.viewEpoch;
    return autoEpoch();
  }
  const epochSlot = (e) => (S.epochs[String(e)] ??= slot());

  // ───────────────────────────── refresh ─────────────────────────────

  async function refreshChain() {
    await load(S.chain, '/chain/state');
  }
  async function refreshNodes(fresh = false) {
    await load(S.nodes, `/chain/nodes${fresh ? '?fresh=1' : ''}`);
  }
  async function refreshConsoleState() {
    await load(S.cstate, '/console/state');
  }
  async function refreshEpoch(e) {
    if (e === null || e === undefined) return;
    await load(epochSlot(e), `/chain/epoch/${e}`);
  }

  /**
   * One refresh round. Every view also reads the OTHER role nodes' status
   * and graph views (less often): the buyer view needs each seller's own
   * view of its offers to spot stale discovered asks, and a seller view
   * needs the buyer's view to show whether its publish propagated.
   */
  async function refreshView({ full = false } = {}) {
    const node = VIEWS[S.view].node;
    const jobs = [];
    for (const n of [1, 2, 3]) {
      if (n === node || full || S.tick % 2 === 0 || !S.status[n].loaded) jobs.push(load(S.status[n], nodePath(n, '/status')));
      const often = n === node && S.view === 'buyer' ? 2 : 3;
      if (full || S.tick % often === 0 || !S.offers[n].loaded) jobs.push(load(S.offers[n], nodePath(n, '/offers'), { timeoutMs: 45_000 }));
    }
    if (S.view === 'buyer') jobs.push(load(S.meter, nodePath(2, '/meter')));
    await Promise.all(jobs);
    const e = viewEpoch();
    const epochs = new Set([e === null ? null : String(e)]);
    const planEpoch = buyerStatus()?.buyer?.epoch;
    if (S.view === 'buyer') {
      if (planEpoch !== undefined) epochs.add(String(planEpoch));
      // Recovery after a node restart: the plan is gone from node memory, so
      // look for node 2's bucket in the console's plan epoch and the current one.
      const consolePlanEpoch = S.cstate.data?.plans?.['2']?.epoch;
      if (consolePlanEpoch) epochs.add(String(consolePlanEpoch));
      const cur = currentEpoch();
      if (cur !== null) epochs.add(String(cur));
    }
    await Promise.all([...epochs].filter(Boolean).map((x) => refreshEpoch(x)));
  }

  /** Refresh everything; a call made while a round is running queues one more round (never dropped). */
  async function refreshAll({ full = false } = {}) {
    if (S.refreshing) {
      S.refreshQueued = { full: Boolean(full || S.refreshQueued?.full) };
      return;
    }
    S.refreshing = true;
    try {
      await Promise.all([
        refreshChain(),
        full || S.tick % 2 === 0 || !S.nodes.loaded ? refreshNodes() : null,
        refreshConsoleState(),
      ]);
      await refreshView({ full });
    } finally {
      S.refreshing = false;
      S.tick += 1;
    }
    render();
    if (S.refreshQueued) {
      const q = S.refreshQueued;
      S.refreshQueued = null;
      await refreshAll(q);
    }
  }

  // ───────────────────────────── network strip ─────────────────────────────

  /**
   * Settlement lifecycle words for an epoch row (server `phase`): the strip,
   * the epoch picker and the settlement panels all use these, so "open"
   * always means "receipts still accepted" and "settled" only ever means
   * "every bucket finalized".
   */
  const PHASE = {
    next: { tag: 'next', short: 'Not started', cls: 'muted' },
    current: { tag: 'current · receipts open', short: 'Receipts open', cls: '' },
    grace: { tag: 'ended · receipts open', short: 'Receipts open (grace)', cls: '' },
    ready: { tag: 'ready to finalize', short: 'Receipts closed · ready to finalize', cls: 'warn-text' },
    settled: { tag: 'settled', short: 'Settled · every bucket finalized', cls: 'ok-text' },
    empty: { tag: 'no buckets', short: 'Deadline passed · no buckets', cls: 'muted' },
  };
  function phaseOf(row) {
    if (!row) return null;
    if (row.phase && PHASE[row.phase]) return row.phase;
    return row.settled ? (W(row.openBuckets) > 0n ? 'ready' : 'settled') : 'current';
  }
  const epochRow = (e) => (S.chain.data?.epochs ?? []).find((r) => W(r.epoch) === W(e)) ?? null;

  function renderStrip() {
    const el = $('#netstrip');
    const c = S.chain.data;
    if (!S.chain.loaded) return;
    el.setAttribute('aria-busy', 'false');
    if (!c) {
      setHtml(el, `<div class="net-error">${errorBox(S.chain.error, { title: 'Chain state unavailable', retry: true })}</div>`);
      renderTimeTravel();
      return;
    }
    const cur = W(c.epoch);
    const ve = viewEpoch() ?? cur;
    const rows = c.epochs ?? [];
    const row = rows.find((r) => W(r.epoch) === ve);
    const options = rows
      .filter((r) => W(r.pool) > 0n || W(r.epoch) === cur || W(r.epoch) === ve)
      .map((r) => {
        const e = W(r.epoch);
        return `<option value="${e}"${e === ve ? ' selected' : ''}>Epoch ${e} · ${esc(PHASE[phaseOf(r)]?.tag ?? '')}</option>`;
      });
    if (!rows.some((r) => W(r.epoch) === ve)) options.push(`<option value="${ve}" selected>Epoch ${ve}</option>`);
    const ahead = Number(W(c.chainAheadSeconds));
    const p = c.params ?? {};
    const phase = phaseOf(row);
    const deadline = row ? row.deadline : c.settlementDeadline;
    const poolUnit = pickUnit(row?.pool ?? 0n);
    const open = W(row?.openBuckets);
    let settleValue;
    if (phase === 'ready') settleValue = `<span class="warn-text">Receipts closed · ready to finalize</span>`;
    else if (phase === 'settled') settleValue = '<span class="ok-text">Settled · all buckets finalized</span>';
    else if (phase === 'empty') settleValue = '<span class="muted">Deadline passed · no buckets</span>';
    else settleValue = `Receipts open · ${countdown(deadline, { future: 'deadline in {}', past: 'deadline passed {} ago' })}`;
    const stale = S.chain.error ? `<div class="net-stale warn-text" role="status">Chain refresh failing (${esc(explain(S.chain.error).code ?? 'error')}) · last good <span data-since-plain="${S.chain.at}"></span> ago <button type="button" class="btn btn-sm" data-action="retry">Retry</button></div>` : '';
    const summary = `Epoch ${esc(cur.toString())} · <span data-chain-clock></span> · ${PHASE[phase]?.short ? esc(`epoch ${ve}: ${PHASE[phase].short}`) : ''}`;
    const html = `
      ${stale}
      <div class="net-summary"><span class="net-summary-text">${summary}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="strip-toggle" aria-expanded="${S.stripOpen}" aria-controls="netstrip">${S.stripOpen ? 'Less' : 'Details'}</button></div>
      <div class="net-cell">
        <div class="net-label">Chain time</div>
        <div class="net-value"><span data-chain-clock></span></div>
        <div class="net-sub">block #${esc(String(c.blockNumber))}${ahead > 60 ? ` · <span class="warn-text">${esc(fmtDur(ahead))} ahead of wall clock</span>` : ''}</div>
      </div>
      <div class="net-cell">
        <div class="net-label">Current epoch</div>
        <div class="net-value">${esc(cur.toString())}</div>
        <div class="net-sub">${countdown(c.epochEnd, { future: 'next epoch in {}', past: 'next epoch due {} ago' })}</div>
      </div>
      <div class="net-cell">
        <div class="net-label"><label for="epoch-select" class="visually-hidden">Settlement epoch</label>Settlement · <select id="epoch-select" aria-label="Settlement epoch to view">${options.join('')}</select></div>
        <div class="net-value">${settleValue}</div>
        <div class="net-sub">deadline ${esc(fmtTime(deadline))}${S.viewEpochPinned ? ' · <button type="button" class="btn btn-ghost btn-sm" data-action="epoch-auto">auto</button>' : ''}</div>
      </div>
      <div class="net-cell net-more">
        <div class="net-label">Epoch ${esc(ve.toString())} pool</div>
        <div class="net-value">${row ? amt(row.pool, { unit: poolUnit }) : '—'}</div>
        <div class="net-sub">${row ? `${row.buyers} buyer${row.buyers === 1 ? '' : 's'} · ${esc(open.toString())} bucket${open === 1n ? '' : 's'} left to finalize` : ''}</div>
      </div>
      <div class="net-cell net-more">
        <div class="net-label">Protocol params</div>
        <div class="net-value">λ ${esc(decimal(W(p.lambdaQif18), 18))} · cap ×${esc(String(p.rewardCapMultiple))}</div>
        <div class="net-sub">soft ceiling ${esc(decimal(BigInt(p.softCeilingBps ?? 0), 2))}% · grace ${esc(fmtDur(Number(W(p.settlementGraceSeconds))))}</div>
      </div>`;
    el.classList.toggle('is-open', S.stripOpen);
    setHtml(el, html);
    renderTimeTravel();
    tickClocks();
  }

  // ───────────────────────────── devnet time travel (dialog) ─────────────────────────────

  /**
   * Time travel is global and irreversible for everyone on the devnet, so it
   * lives behind a low-weight “Devnet time travel…” button (after the
   * perspective tabs) that opens a dialog spelling out the consequences.
   */
  function renderTimeTravel() {
    const opener = $('#tt-open');
    const c = S.chain.data;
    if (opener) {
      opener.disabled = !c || Boolean(S.busy.warp);
      opener.innerHTML = S.busy.warp ? '<span class="spin"></span>Time travelling…' : 'Devnet time travel…';
    }
    const body = $('#tt-body');
    if (!body) return;
    if (!c) {
      setHtml(body, errorBox(S.chain.error ?? { status: 0, text: 'chain state not loaded' }, { title: 'Chain state unavailable' }));
      return;
    }
    const cur = W(c.epoch);
    const ve = viewEpoch() ?? cur;
    const row = epochRow(ve);
    const past = row ? row.pastDeadline ?? row.settled : false;
    const jump = row ? Number(W(row.secondsToDeadline)) + 15 : 0;
    const epochEndsInJump = row && W(c.epochEnd) <= W(row.deadline);
    setHtml(body, `
      <p class="tt-warning"><strong>Irreversible, and it affects everyone on this devnet.</strong> Chain time cannot be moved back. Everyone using this console (and every node) sees the new time.</p>
      <div class="tt-option">
        <div>
          <div class="tt-option-title">Jump to epoch ${esc(ve.toString())}’s settlement deadline ${past ? '' : `<span class="muted">(+${esc(fmtDur(jump))})</span>`}</div>
          ${past
            ? `<p class="hint">Epoch ${esc(ve.toString())}’s deadline has already passed (${esc(fmtTime(row?.deadline))}).</p>`
            : `<ul class="tt-effects">
              ${epochEndsInJump ? `<li>Epoch ${esc(cur.toString())} ends. Every buyer plan for epoch ${esc(cur.toString())} stops working: sellers refuse new calls with <code>SETTLEMENT_CLOSED</code>, and buyers must subscribe again for epoch ${esc((cur + 1n).toString())}.</li>` : ''}
              <li>Receipts for epoch ${esc(ve.toString())} can no longer land on-chain; unflushed receipts are lost to the sellers.</li>
              <li>Every epoch-${esc(ve.toString())} bucket becomes finalizable (by anyone); rewards become claimable once all are finalized.</li>
            </ul>`}
        </div>
        <button type="button" class="btn btn-danger" data-action="tt-deadline" ${past || S.busy.warp ? 'disabled' : ''}>${S.busy.warp === 'deadline' ? '<span class="spin"></span>' : ''}Jump +${esc(fmtDur(jump))}</button>
      </div>
      <div class="tt-option">
        <div>
          <div class="tt-option-title">Advance one hour</div>
          <p class="hint">Useful to expire authorizations or offers. Crosses an epoch boundary only if one is less than an hour away (${countdown(c.epochEnd, { future: 'next epoch in {}', past: 'next epoch due {} ago' })}).</p>
        </div>
        <button type="button" class="btn btn-warn" data-action="tt-hour" ${S.busy.warp ? 'disabled' : ''}>${S.busy.warp === 'hour' ? '<span class="spin"></span>' : ''}+1 hour</button>
      </div>
      <p class="hint">Uses Hardhat <code>evm_increaseTime</code> + <code>evm_mine</code>. Nodes notice the new time within ~30 s.</p>`);
  }

  function openTimeTravel() {
    const dlg = $('#tt-dialog');
    if (!dlg) return;
    renderTimeTravel();
    tickClocks();
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
    $('#tt-cancel')?.focus();
  }

  function closeTimeTravel() {
    const dlg = $('#tt-dialog');
    if (dlg?.open) dlg.close();
  }

  /** Inline pointer to the time-travel dialog for “wait for the deadline” states. */
  const ttHint = () => ' On this devnet you can skip ahead: <button type="button" class="btn btn-sm btn-link" data-action="open-timetravel">Devnet time travel…</button>';

  // ───────────────────────────── rendering helpers ─────────────────────────────

  /** Replace innerHTML only when it changed; keep focus on the same control. */
  function setHtml(el, html) {
    if (!el || el._html === html) return;
    const active = document.activeElement;
    let focusKey = null;
    if (active && el.contains(active)) {
      focusKey = active.id ? `#${active.id}` : active.dataset?.action ? `[data-action="${active.dataset.action}"]${active.dataset.arg ? `[data-arg="${active.dataset.arg}"]` : ''}` : null;
    }
    el._html = html;
    el.innerHTML = html;
    applyGeometry(el);
    if (focusKey) {
      try {
        el.querySelector(focusKey)?.focus();
      } catch {
        /* selector edge case */
      }
    }
  }

  /** CSP-safe sizing: data-w / data-left → CSSOM styles. */
  function applyGeometry(root) {
    for (const n of root.querySelectorAll('[data-w]')) n.style.width = `${n.dataset.w}%`;
    for (const n of root.querySelectorAll('[data-left]')) n.style.left = `${n.dataset.left}%`;
  }

  function setBody(id, html) {
    setHtml(document.getElementById(`b-${id}`), html);
  }
  function setMeta(id, html) {
    setHtml(document.getElementById(`m-${id}`), html);
  }

  function panel(id, title, { span = 12, step, footer = '' } = {}) {
    return `<section class="panel span-${span}" id="p-${id}" aria-labelledby="h-${id}">
      <header class="panel-h">${step ? `<span class="step">${esc(step)}</span>` : ''}<h2 id="h-${id}">${esc(title)}</h2><span class="meta" id="m-${id}"></span></header>
      <div class="panel-b" id="b-${id}">${skeleton()}</div>
      ${footer}
    </section>`;
  }

  function tickClocks() {
    const now = chainNowSec();
    for (const el of $$('[data-countdown]')) {
      const d = Number(el.dataset.countdown);
      const left = d - now;
      el.classList.toggle('is-past', left < 0);
      const tpl = left >= 0 ? (el.dataset.future ?? 'in {}') : (el.dataset.past ?? '{} ago');
      el.textContent = tpl.replace('{}', fmtDur(Math.abs(left)));
    }
    for (const el of $$('[data-chain-clock]')) el.textContent = fmtClock(now);
    const ago = (at) => fmtDur(Math.max(0, Math.round((Date.now() - Number(at)) / 1000)));
    for (const el of $$('[data-since]')) {
      el.textContent = el.dataset.stale ? `refresh failing · last good ${ago(el.dataset.since)} ago` : `updated ${ago(el.dataset.since)} ago`;
    }
    for (const el of $$('[data-since-plain]')) el.textContent = ago(el.dataset.sincePlain);
  }

  // ───────────────────────────── view mounting ─────────────────────────────

  function mountView() {
    const main = $('#view');
    main.setAttribute('aria-labelledby', `tab-${S.view}`);
    for (const t of $$('[role="tab"]')) {
      const on = t.dataset.view === S.view;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    main._html = null;
    if (S.view === 'buyer') {
      main.innerHTML = `
        <p class="view-intro">You are the <strong>buyer</strong> (node 2). Fund a period subscription, let the router pick the cheapest eligible seller per call, watch the meter, and finalize your bucket after the settlement deadline. Your node signs every call with its session key; the console never sees a key.</p>
        <div class="grid">
          ${panel('plan', 'Your plan & usage meter', { span: 7, step: '1' })}
          ${panel('subscribe', 'Subscribe', { span: 5, step: '2' })}
          ${panel('offers', 'Offers on the network', { span: 12, step: '3' })}
          ${panel('try', 'Try it', { span: 7, step: '4' })}
          ${panel('history', 'This session’s calls', { span: 5 })}
          ${panel('settle', 'Settlement', { span: 12, step: '5' })}
        </div>`;
      mountSubscribe();
      mountPlayground();
    } else {
      const n = VIEWS[S.view].node;
      main.innerHTML = `
        <p class="view-intro">You are <strong>${esc(VIEWS[S.view].title)}</strong> (node ${n}, a core node). Publish offerings as Knowledge Assets, serve buyer calls, flush signed receipts on-chain as claims, and claim your share of the epoch pool once every bucket is finalized.</p>
        <div class="grid">
          ${panel('seller', 'Seller node', { span: 5, step: '1' })}
          ${panel('offerings', 'Offerings', { span: 7, step: '2' })}
          ${panel('receipts', 'Receipts', { span: 5, step: '3' })}
          ${panel('claims', 'Claims on-chain', { span: 7, step: '4' })}
          ${panel('rewards', 'Epoch reward', { span: 12, step: '5' })}
        </div>`;
      mountOfferings(n);
    }
    render();
  }

  function render() {
    renderStrip();
    if (S.view === 'buyer') {
      renderPlan();
      renderSubscribeLive();
      renderOffers();
      renderPlaygroundLive();
      renderHistory();
      renderBuyerSettlement();
    } else {
      const n = VIEWS[S.view].node;
      renderSellerStatus(n);
      renderOfferingsLive(n);
      renderReceipts(n);
      renderClaims(n);
      renderRewards(n);
    }
    tickClocks();
  }

  // ───────────────────────────── BUYER: plan & meter ─────────────────────────────

  /** Has the plan's epoch ended (chain is in a later epoch)? */
  function planEnded(planEpoch) {
    const cur = currentEpoch();
    return planEpoch !== null && planEpoch !== undefined && cur !== null && cur > W(planEpoch);
  }

  /**
   * Node 2's bucket for the plan panel. With a live plan, the plan epoch's
   * bucket. Without one (e.g. node 2 restarted: plan and meter live in node
   * memory), look in the console's plan epoch, the current epoch and the
   * viewed epoch, so the recovery state can render.
   */
  function findMyBucket(planEpoch) {
    const tries = planEpoch !== null
      ? [planEpoch]
      : [S.cstate.data?.plans?.['2']?.epoch, currentEpoch(), viewEpoch()].filter((x) => x !== null && x !== undefined);
    for (const e of tries) {
      const bucket = S.epochs[String(e)]?.data?.buckets?.find((x) => x.buyerNode === 2);
      if (bucket) return { bucket, epoch: W(e) };
    }
    return { bucket: null, epoch: null };
  }

  function renderPlan() {
    const st = S.status[2];
    if (!st.loaded) return;
    if (!st.data) {
      setBody('plan', errorBox(st.error, { retry: true }));
      return;
    }
    setMeta('plan', since(st.at, st));
    const s = st.data;
    const b = s.buyer ?? {};
    const node = nodeInfo(2);
    const planEpoch = b.epoch !== undefined ? String(b.epoch) : null;
    const found = findMyBucket(planEpoch);
    const myBucket = found.bucket;
    const bucketEpoch = found.epoch;
    const ended = b.subscribed && planEnded(planEpoch);
    const keyBound = myBucket && b.sessionKeyAddress && String(myBucket.activeSessionKey).toLowerCase() === String(b.sessionKeyAddress).toLowerCase();
    const meter = b.subscribed ? (S.meter.data?.state ?? b.meter) : null;
    const unit = pickUnit(myBucket?.funded ?? 0n, meter?.totalBudgetWei ?? 0n, ...(meter?.buckets ?? []).map((x) => x.budgetWei));
    const parts = [staleBanner(st, S.meter, S.nodes)];
    if (!s.enabled) {
      setBody('plan', warnBox('Marketplace disabled on node 2', 'Enable <code>marketplace.enabled</code> in the node config (or DKG_MARKETPLACE_ENABLED=1) and restart the devnet.'));
      return;
    }
    if (s.degraded) parts.push(warnBox('Marketplace degraded on node 2', esc(s.degraded)));
    const cur = currentEpoch();
    let planV;
    let planS;
    if (!b.subscribed) {
      planV = '<span class="muted">None</span>';
      planS = 'subscribe to start';
    } else if (ended) {
      planV = '<span class="warn-text">Ended</span>';
      planS = `epoch ${esc(planEpoch)} is over · subscribe for epoch ${esc(String(cur))}`;
    } else {
      planV = '<span class="ok-text">Active</span>';
      planS = `epoch ${esc(planEpoch)}`;
    }
    // used (meter) vs claimed (on-chain): the gap is receipts sellers have not flushed yet.
    const used = meter ? W(meter.totalSettledWei) : null;
    const claimed = myBucket ? W(myBucket.totalClaimed) : null;
    const pending = used !== null && claimed !== null && used > claimed ? used - claimed : 0n;
    const bucketSub = myBucket
      ? `funded${bucketEpoch !== null && String(bucketEpoch) !== planEpoch ? ` for epoch ${esc(String(bucketEpoch))}` : ''} · ${amt(myBucket.totalClaimed, { unit })} claimed on-chain (${pctOf(myBucket.totalClaimed, myBucket.funded)})${pending > 0n ? ` · ${amt(pending, { unit })} waiting for sellers to flush` : ''}`
      : planEpoch ? 'not funded' : 'no bucket yet';
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">Plan</div><div class="v">${planV}</div><div class="s">${planS}</div></div>
      <div class="stat"><div class="k">On-chain bucket</div><div class="v">${myBucket ? amt(myBucket.funded, { unit }) : '—'}</div><div class="s">${bucketSub}</div></div>
      <div class="stat"><div class="k">Funding wallet</div><div class="v">${node ? amt(node.primaryTracWei, { unit: 'trac' }) : S.nodes.error ? '<span class="muted">unknown</span>' : '—'}</div><div class="s hex">${node?.primaryWallet ? esc(shortHex(node.primaryWallet)) : S.nodes.error ? 'chain unreachable' : ''}</div></div>
    </div>`);
    parts.push(`<dl class="kv">
      <dt>Session key</dt><dd>${b.sessionKeyAddress ? `<span class="hex">${esc(b.sessionKeyAddress)}</span> ${keyBound ? '<span class="tag tag-ok">registered on-chain</span>' : myBucket ? '<span class="tag tag-warn">not the active key</span>' : ''}` : '<span class="muted">created on first subscribe</span>'}</dd>
      ${myBucket ? `<dt>Bucket state</dt><dd>${myBucket.finalized ? '<span class="tag tag-ok">finalized</span>' : (epochRow(bucketEpoch)?.pastDeadline ?? epochRow(bucketEpoch)?.settled) ? '<span class="tag tag-warn">ready to finalize</span>' : '<span class="tag tag-info">receipts open</span>'} ${myBucket.overClaimed ? '<span class="tag tag-warn">over-claimed → pro-rata</span>' : ''}</dd>` : ''}
    </dl>`);
    if (!b.subscribed) {
      if (myBucket && cur !== null && bucketEpoch !== null && bucketEpoch >= cur) {
        parts.push(warnBox(`On-chain bucket found for epoch ${esc(String(bucketEpoch))}, but no local plan`, 'The buyer node keeps its plan and meter in memory, so a node restart loses them (the bucket and its funds stay on-chain). Subscribe again for this epoch, any amount, to restore a plan and meter.'));
      } else if (myBucket) {
        parts.push(emptyBox('No active plan', `Your epoch-${esc(String(bucketEpoch))} bucket is from an epoch that has ended — see <strong>Settlement</strong> below. Fund a new subscription in <strong>Subscribe</strong> to make calls in epoch ${esc(String(cur ?? '?'))}.`));
      } else {
        parts.push(emptyBox('No active plan', 'Fund a subscription in <strong>Subscribe</strong>. The funding is non-refundable and lands in the epoch’s network reward pool — no seller is named up front.'));
      }
    } else {
      if (ended) {
        parts.push(warnBox(`Plan ended with epoch ${esc(planEpoch)}`, `The chain is in epoch ${esc(String(cur))}. Sellers refuse calls for an ended epoch (<code>SETTLEMENT_CLOSED</code>). Subscribe for epoch ${esc(String(cur))} to keep calling; the old bucket settles under <strong>Settlement</strong>.`));
      }
      const summary = S.meter.data?.summary;
      if (meter) {
        const total = W(meter.totalBudgetWei);
        const left = total - W(meter.totalSettledWei) - W(meter.totalReservedWei);
        parts.push(`<div class="summary-line">used ${amt(meter.totalSettledWei, { unit })}${W(meter.totalReservedWei) > 0n ? ` + ${amt(meter.totalReservedWei, { unit })} reserved` : ''} · remaining ${amt(left > 0n ? left : 0n, { unit })} of ${amt(total, { unit })}${summary ? `<details class="inline-details"><summary>node’s meter line</summary><code>${esc(summary)}</code></details>` : ''}</div>`);
      }
      parts.push(renderMeters(meter, planEpoch, unit));
    }
    setBody('plan', parts.join('') + `<div class="panel-actions-inline"><div class="row">
      <button type="button" class="btn btn-warn btn-sm" data-action="topup" aria-describedby="topup-hint" ${S.busy.topup ? 'disabled' : ''}>${S.busy.topup ? '<span class="spin"></span>' : ''}Top up wallet +100 TRAC (devnet)</button>
      <span class="hint" id="topup-hint" title="Writes the Token contract’s ERC-20 balance slot for node 2’s first operational wallet, adding to the existing balance.">Adds 100 test TRAC to node 2’s wallet, keeping what is there. Devnet only.</span></div></div>`);
  }

  function renderMeters(meter, planEpoch, unit = 'micro') {
    if (!meter?.buckets?.length) return emptyBox('Meter not available yet');
    const ap = activePlan();
    const policy = ap?.policy;
    const bps = BigInt(meter.softCeilingBps ?? 9500);
    const row = planEpoch ? epochRow(planEpoch) : null;
    const ended = planEnded(planEpoch);
    const lifetime = !row
      ? ''
      : ended
        ? `<span class="warn-text">epoch ${esc(String(planEpoch))} ${countdown(row.end, { future: 'ends in {}', past: 'ended {} ago' })} — calls are refused</span>`
        : `usable until epoch ${esc(String(planEpoch))} ends (${countdown(row.end, { future: 'in {}', past: '{} ago' })}) · receipts settle until the deadline (${countdown(row.deadline, { future: 'in {}', past: 'passed {} ago' })})`;
    const html = meter.buckets.map((bk, i) => {
      const budget = W(bk.budgetWei);
      const settled = W(bk.settledWei);
      const reserved = W(bk.reservedWei);
      const remaining = budget - settled - reserved;
      const allowance = remaining > 0n ? (remaining * bps) / 10000n : 0n;
      const ceilingAt = settled + reserved + allowance;
      const pb = policy?.buckets?.[i];
      const label = pb ? `${SERVICE_LABEL[pb.match?.serviceType] ?? pb.match?.serviceType}${pb.match?.modelId ? ` · ${esc(pb.match.modelId)}` : ''}` : `Bucket ${i + 1}`;
      const unitName = UNIT_OF_SERVICE[pb?.match?.serviceType];
      const cap = pb ? ` · cap ${askAmt(pb.priceCapWeiPerUnit, unitName)} · max ${esc(groupInt(String(pb.maxUnitsPerCall)))} units / call` : '';
      return `<div class="meter">
        <div class="meter-head"><strong>${label}</strong><span class="muted">${cap}</span>
          <span class="right">${amt(settled, { unit })} used${reserved > 0n ? ` + ${amt(reserved, { unit })} reserved` : ''} of ${amt(budget, { unit })}</span></div>
        <div class="meter-bar" role="img" aria-label="${esc(`${label}: ${pctOf(settled, budget)} used, ${pctOf(reserved, budget)} reserved; next-call limit at ${pctOf(ceilingAt, budget)} of the budget`)}">
          <span class="seg settled" data-w="${widthPct(settled, budget)}"></span>
          <span class="seg reserved" data-w="${widthPct(reserved, budget)}"></span>
          <span class="ceiling" data-left="${widthPct(ceilingAt, budget)}" title="Next-call limit (soft ceiling): the next call's worst case must end before this line — 95% of what is left"><span class="ceiling-label">limit</span></span>
        </div>
        <div class="meter-foot">
          <span class="legend"><i class="l-settled"></i><span>settled ${pctOf(settled, budget)}</span></span>
          <span class="legend"><i class="l-reserved"></i><span>reserved ${pctOf(reserved, budget)}</span></span>
          <span class="legend"><i class="l-ceiling"></i><span>next-call limit: worst case ≤ ${amt(allowance, { unit })} (95% of the ${amt(remaining > 0n ? remaining : 0n, { unit })} left)</span></span>
        </div>
      </div>`;
    });
    const note = policy ? '' : `<p class="hint">Bucket labels unknown — this plan was not funded through the console.</p>`;
    return html.join('') + (lifetime ? `<p class="meter-life">${lifetime}</p>` : '') + note;
  }

  // ───────────────────────────── BUYER: subscribe ─────────────────────────────

  function initSubForm() {
    if (S.sub) return;
    const plan = S.cstate.data?.plans?.['2'];
    const fromPlan = plan?.policy?.buckets?.length
      ? {
          amountTrac: plan.lastAmountWei ? decimal(W(plan.lastAmountWei), 18).replace(/,/g, '') : DEFAULT_PLAN.amountTrac,
          buckets: plan.policy.buckets.map((b) => ({
            serviceType: b.match?.serviceType ?? 'inference',
            modelId: b.match?.modelId ?? '',
            budgetTrac: decimal(W(b.budgetWei), 18).replace(/,/g, ''),
            capMicro: decimal(W(b.priceCapWeiPerUnit), 12).replace(/,/g, ''),
            maxUnits: String(b.maxUnitsPerCall),
          })),
          deny: new Set((plan.policy.sellerDeny ?? []).map(String)),
        }
      : null;
    S.sub = {
      amountTrac: fromPlan?.amountTrac ?? DEFAULT_PLAN.amountTrac,
      epochChoice: 'current',
      buckets: (fromPlan?.buckets ?? DEFAULT_PLAN.buckets).map((b) => ({ ...b })),
      deny: fromPlan?.deny ?? new Set(),
      showWei: false,
      touched: false,
    };
  }

  function mountSubscribe() {
    initSubForm();
    const f = S.sub;
    const rows = f.buckets.map((b, i) => `
      <div class="bucket-row" data-bucket="${i}">
        <div class="field">
          <label for="sb-svc-${i}">Service</label>
          <select id="sb-svc-${i}" data-sub="serviceType" data-i="${i}">
            ${SERVICE_TYPES.map((t) => `<option value="${t}"${t === b.serviceType ? ' selected' : ''}>${esc(SERVICE_LABEL[t])}</option>`).join('')}
          </select>
          <input type="text" id="sb-model-${i}" data-sub="modelId" data-i="${i}" value="${esc(b.modelId)}" placeholder="any model" aria-label="Model id (optional)" class="mt-1">
        </div>
        <div class="field">
          <label for="sb-budget-${i}">Budget <span class="unit">TRAC</span></label>
          <input type="text" inputmode="decimal" id="sb-budget-${i}" data-sub="budgetTrac" data-i="${i}" value="${esc(b.budgetTrac)}">
          <div class="micro-preview" data-micro="budget-${i}"></div>
          <div class="wei-preview" data-preview="budget-${i}"></div>
          <div class="hint danger-text" data-err="b${i}.budget"></div>
        </div>
        <div class="field">
          <label for="sb-cap-${i}" title="Price cap per unit, in µTRAC">Cap <span class="unit">µTRAC/unit</span></label>
          <input type="text" inputmode="decimal" id="sb-cap-${i}" data-sub="capMicro" data-i="${i}" value="${esc(b.capMicro)}">
          <div class="wei-preview" data-preview="cap-${i}"></div>
          <div class="hint danger-text" data-err="b${i}.cap"></div>
        </div>
        <div class="field">
          <label for="sb-units-${i}" title="The most units one call may use from this bucket (maxUnitsPerCall)">Max units / call</label>
          <input type="text" inputmode="numeric" id="sb-units-${i}" data-sub="maxUnits" data-i="${i}" value="${esc(b.maxUnits)}">
          <div class="hint danger-text" data-err="b${i}.units"></div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm rm" data-action="sub-rm" data-arg="${i}" aria-label="Remove bucket ${i + 1}" title="Remove bucket" ${f.buckets.length <= 1 ? 'disabled' : ''}>×</button>
      </div>`).join('');
    const html = `
      <form id="sub-form" novalidate class="${f.showWei ? 'show-wei-form' : ''}">
        <p class="lede">Funding is <strong>non-refundable</strong> and goes into the epoch’s network reward pool. Buckets are your node’s local spending lines: for each call it enforces the bucket’s price cap and max units per call, and it refuses to route a call whose worst case (max units × ask) is more than 95% of what is left in the bucket (the soft ceiling).</p>
        <div class="form-grid">
          <div class="field">
            <label for="sb-amount">Fund <span class="unit">TRAC</span></label>
            <input type="text" inputmode="decimal" id="sb-amount" data-sub="amountTrac" value="${esc(f.amountTrac)}" autocomplete="off">
            <div class="micro-preview" data-micro="amount"></div>
            <div class="wei-preview" data-preview="amount"></div>
            <div class="hint danger-text" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="sb-epoch">Epoch</label>
            <select id="sb-epoch" data-sub="epochChoice">
              <option value="current"${f.epochChoice === 'current' ? ' selected' : ''}>Current epoch</option>
              <option value="next"${f.epochChoice === 'next' ? ' selected' : ''}>Next epoch</option>
            </select>
            <div class="hint" data-epoch-hint></div>
          </div>
        </div>
        <div class="section-label">Buckets</div>
        <div class="bucket-rows">${rows}</div>
        <div class="row mt-2">
          <button type="button" class="btn btn-sm" data-action="sub-add">Add bucket</button>
          <label class="check"><input type="checkbox" data-sub="showWei"${f.showWei ? ' checked' : ''}> Show exact wei</label>
        </div>
        <div class="section-label">Seller deny list <span class="label-note">optional</span></div>
        <div class="deny-list" id="sub-deny"></div>
        <div class="hint" id="sub-deny-note"></div>
        <div class="totals" id="sub-totals"></div>
        <div class="hint danger-text" data-err="buckets"></div>
        <div id="sub-result" aria-live="polite"></div>
      </form>`;
    const body = document.getElementById('b-subscribe');
    body._html = null;
    body.innerHTML = html;
    const footer = document.getElementById('p-subscribe').querySelector('.panel-f');
    if (!footer) {
      document.getElementById('p-subscribe').insertAdjacentHTML('beforeend', `<div class="panel-f"><span class="grow hint" id="sub-note"></span><button type="button" class="btn btn-primary" data-action="subscribe" id="sub-submit" aria-describedby="sub-note">Fund &amp; subscribe</button></div>`);
    }
    updateSubPreviews();
    renderSubscribeLive();
  }

  function updateSubPreviews() {
    const f = S.sub;
    const d = draftPlan();
    const setPrev = (k, fn) => {
      const el = $(`[data-preview="${k}"]`);
      if (!el) return;
      try {
        el.textContent = `= ${groupInt(fn().toString())} wei`;
      } catch {
        el.textContent = '';
      }
    };
    // Same unit the plan meter and settlement panels use, so “0.006 TRAC”
    // here is recognisably the “6,000 µTRAC” bucket there.
    const setMicro = (k, fn) => {
      const el = $(`[data-micro="${k}"]`);
      if (!el) return;
      try {
        const v = fn();
        el.textContent = `= ${decimal(v, 12)} µTRAC`;
      } catch {
        el.textContent = '';
      }
    };
    setPrev('amount', () => parseTrac(f.amountTrac));
    setMicro('amount', () => parseTrac(f.amountTrac));
    f.buckets.forEach((b, i) => {
      setPrev(`budget-${i}`, () => parseTrac(b.budgetTrac));
      setMicro(`budget-${i}`, () => parseTrac(b.budgetTrac));
      setPrev(`cap-${i}`, () => parseMicro(b.capMicro));
    });
    for (const el of $$('#sub-form [data-err]')) el.textContent = f.touched ? (d.errors[el.dataset.err] ?? '') : '';
    for (const el of $$('#sub-form [data-sub]')) {
      const i = el.dataset.i;
      const key = { amountTrac: 'amount', budgetTrac: `b${i}.budget`, capMicro: `b${i}.cap`, maxUnits: `b${i}.units` }[el.dataset.sub];
      el.classList.toggle('is-invalid', Boolean(f.touched && key && d.errors[key]));
    }
    const totals = $('#sub-totals');
    if (totals) {
      const over = d.total > d.amountWei && d.amountWei > 0n;
      const unit = pickUnit(d.total, d.amountWei);
      totals.innerHTML = `<span>Plan total (Σ budgets): <strong>${amt(d.total, { unit })}</strong></span><span>Funding: <strong>${amt(d.amountWei, { unit })}</strong></span>${over ? '<span class="warn-text">Budgets exceed funding — sellers may over-claim; finalization then pro-rates.</span>' : ''}`;
    }
  }

  function renderSubscribeLive() {
    if (!S.sub) return;
    const cur = currentEpoch();
    const hint = $('[data-epoch-hint]');
    if (hint && cur !== null) hint.textContent = S.sub.epochChoice === 'next' ? `funds epoch ${cur + 1n}` : `funds epoch ${cur}`;
    // deny list from discovered sellers + known seller nodes
    const deny = $('#sub-deny');
    if (deny) {
      const ids = new Map();
      for (const o of S.offers[2].data?.offers ?? []) ids.set(W(o.sellerIdentityId).toString(), true);
      for (const n of [1, 3]) {
        const id = W(nodeInfo(n)?.identityId);
        if (id > 0n) ids.set(id.toString(), true);
      }
      const html = ids.size === 0
        ? '<span class="hint">Sellers appear here once their identities are known.</span>'
        : [...ids.keys()].sort((a, b) => Number(a) - Number(b)).map((id) => `<label class="check"><input type="checkbox" data-deny="${esc(id)}"${S.sub.deny.has(id) ? ' checked' : ''}> ${whoIdentity(id)}</label>`).join('');
      setHtml(deny, html);
    }
    const note = $('#sub-note');
    const st = buyerStatus();
    const ended = st?.buyer?.subscribed && planEnded(st.buyer.epoch);
    const replacing = st?.buyer?.subscribed && !ended;
    // Unreachable = the last status refresh failed (data may be stale) or never loaded.
    const unreachable = !S.status[2].data || Boolean(S.status[2].error);
    if (note) {
      note.innerHTML = unreachable
        ? '<span class="warn-text">Buyer node unreachable — subscribing is disabled until node 2 answers again.</span>'
        : ended
          ? `Your plan’s epoch ${esc(String(st.buyer.epoch))} is over: this funds a new bucket and replaces the local plan &amp; meter.`
          : replacing
            ? 'Subscribing again adds funds to the epoch’s bucket and replaces the local plan &amp; meter (deny-list and cap changes apply from then on).'
            : 'Node 2 pays from its own wallet and signs the on-chain funding itself; the console never holds a key.';
    }
    const btn = $('#sub-submit');
    if (btn) {
      btn.disabled = Boolean(S.busy.subscribe) || unreachable;
      btn.innerHTML = S.busy.subscribe ? '<span class="spin"></span>Funding…' : replacing ? 'Add funds &amp; replace plan' : 'Fund &amp; subscribe';
    }
    const h = $('#h-subscribe');
    if (h) h.textContent = replacing ? 'Top up / change plan' : 'Subscribe';
    // Deny-list edits only reach the router once the plan is replaced.
    const denyNote = $('#sub-deny-note');
    if (denyNote) {
      const ap = activePlan();
      const activeDeny = new Set((ap?.policy?.sellerDeny ?? []).map(String));
      const differs = ap?.policy && (activeDeny.size !== S.sub.deny.size || [...S.sub.deny].some((x) => !activeDeny.has(x)));
      denyNote.innerHTML = differs && replacing
        ? '<span class="warn-text">Not applied yet: the active plan still uses its old deny list (Offers and Try it preview the active plan). Click “Add funds &amp; replace plan” to apply it.</span>'
        : '';
    }
    const res = $('#sub-result');
    if (res) {
      const r = S.results.subscribe;
      setHtml(res, r ? (r.ok
        ? okBox('Subscribed', `Epoch ${esc(String(r.json.epoch))} funded with ${amt(r.json.amountWei, { unit: pickUnit(r.json.amountWei) })} · tx <span class="hex">${esc(shortHex(r.json.txHash, 10, 8))}</span> · block ${esc(String(r.json.blockNumber))}`)
        : errorBox(r)) : '');
    }
    updateSubPreviews();
  }

  async function doSubscribe() {
    const f = S.sub;
    f.touched = true;
    const d = draftPlan();
    updateSubPreviews();
    if (Object.keys(d.errors).length > 0) {
      toast('Fix the highlighted fields first.', 'warn');
      return;
    }
    const wallet = W(nodeInfo(2)?.primaryTracWei);
    if (S.nodes.data && wallet < d.amountWei) {
      // Checked in the browser; nothing was sent (explain() labels it as such).
      S.results.subscribe = { ok: false, local: true, status: 0, json: { error: `Node 2’s funding wallet holds ${trac(wallet)} TRAC, less than the ${trac(d.amountWei)} TRAC you want to fund. Use “Top up wallet +100 TRAC” in the plan panel, or fund less.` } };
      renderSubscribeLive();
      return;
    }
    const cur = currentEpoch();
    const body = { amountWei: d.amountWei.toString(), policy: d.policy };
    if (cur !== null) body.epoch = (f.epochChoice === 'next' ? cur + 1n : cur).toString();
    S.busy.subscribe = true;
    renderSubscribeLive();
    const r = await api(nodePath(2, '/subscribe'), { method: 'POST', body, timeoutMs: 120_000 });
    S.busy.subscribe = false;
    S.results.subscribe = r;
    if (r.ok) {
      toast(`Subscribed: epoch ${esc(String(r.json.epoch))}, ${amt(r.json.amountWei, { unit: pickUnit(r.json.amountWei) })} funded.`);
      S.meter.loaded = false;
    }
    await refreshAll({ full: true });
  }

  // ───────────────────────────── BUYER: offers ─────────────────────────────

  function renderOffers() {
    const o = S.offers[2];
    if (!o.loaded) return;
    setMeta('offers', `buyer node 2’s view · ${since(o.at, o)}`);
    if (!o.data) {
      const msg = String(o.error?.json?.error ?? '');
      if (/read authority is unavailable|context graph/i.test(msg)) {
        setBody('offers', `${infoBox('Waiting for the marketplace context graph', 'This node has not synced the <code>marketplace</code> context graph yet — no seller has published, or its on-chain registration has not reached this node. Discovery normally takes seconds after the first seller publish (up to about a minute); polling continues.')}
          <details><summary class="hint">Raw message</summary><div class="hex">${esc(msg)}</div></details>`);
      } else {
        setBody('offers', errorBox(o.error, { retry: true }));
      }
      return;
    }
    const offers = dedupeOffers(o.data.offers);
    if (offers.length === 0) {
      setBody('offers', emptyBox('No offers discovered yet', 'Sellers publish offers as Knowledge Assets into the shared <code>marketplace</code> context graph. After the first publish, discovery on this node normally takes seconds (up to about a minute); every refresh nudges a re-sync. (Seed with <code>pnpm devnet:marketplace:seed</code>.)'));
      return;
    }
    const ap = activePlan();
    const st = buyerStatus();
    const subscribed = Boolean(st?.buyer?.subscribed);
    const usingDraft = !ap?.policy;
    const policy = ap?.policy ?? (S.sub ? draftPlan().policy : null);
    const { verdict } = routerPreview(offers, policy);
    let anyStale = false;
    const rows = offers.map((x) => {
      const v = verdict.get(offerKey(x)) ?? {};
      const side = v.side ?? sellerSide(x);
      const discovered = W(x.askPerUnitWei);
      let askNote = '';
      if (side.served === false) {
        anyStale = true;
        askNote = `<div class="why warn-text ask-note">${esc(nodeName(side.node))} no longer serves this offering — its live quote will decline</div>`;
      } else if (side.stale) {
        anyStale = true;
        const from = side.source === 'quote' ? 'seen in a live quote' : side.source === 'console' ? 'published via this console' : 'in the seller’s own graph view';
        askNote = `<div class="why warn-text ask-note"><span class="tag tag-warn">stale</span> seller now asks ${askAmt(side.liveAsk, x.unit)} (${esc(from)}); this node has not received the update yet</div>`;
      }
      const routerCell = v.pick
        ? `<span class="tag tag-ok">router pick</span>${side.stale && side.liveAsk !== null ? '<div class="why">ranked on the seller’s current ask</div>' : ''}`
        : v.why ? `<span class="why">${esc(v.why)}</span>` : '<span class="why">—</span>';
      return `<tr class="${v.pick ? 'is-pick' : ''}">
        <td data-label="Seller">${whoIdentity(x.sellerIdentityId)}<div class="why hex">peer …${esc(String(x.sellerPeerId).slice(-8))}</div></td>
        <td data-label="Router">${routerCell}</td>
        <td class="r" data-label="Ask">${askAmt(discovered, x.unit)}${askNote}</td>
        <td data-label="Service">${esc(SERVICE_LABEL[x.serviceType] ?? x.serviceType)}${x.modelId ? `<div class="why">${esc(x.modelId)}</div>` : ''}</td>
        <td data-label="Offering"><code>${esc(localIdOf(x.offerId) || shortHex(x.offeringId))}</code></td>
      </tr>`;
    }).join('');
    const basis = usingDraft
      ? subscribed
        ? 'the <strong>Subscribe form’s values</strong> (your active plan was funded outside this console, so its caps and deny list are unknown here)'
        : '<strong>your draft plan</strong> in Subscribe (not subscribed yet)'
      : 'your <strong>active plan</strong>';
    setBody('offers', `${staleBanner(o)}
      <p class="lede">${offers.length} offer${offers.length === 1 ? '' : 's'} discovered in node 2’s view of the <code>marketplace</code> context graph. The <strong>router ranks on each seller’s live quote</strong>, not on the discovered ask; where a seller’s own node reports a newer ask, it is flagged and used here. “Router” previews the pick with ${basis}; at call time the live quotes and the soft ceiling decide.</p>
      ${anyStale ? warnBox('Some discovered asks are out of date', 'A seller changed an offer and buyer node 2 has not applied the update yet. An update usually arrives within seconds and at most about a minute later; the seller’s Offerings panel warns when one takes longer. Calls still use the seller’s live quote, so you pay the current ask.') : ''}
      <div class="table-wrap"><table class="table-cards">
        <thead><tr><th>Seller</th><th>Router</th><th class="r">Ask (discovered)</th><th>Service</th><th>Offering</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`);
  }

  // ───────────────────────────── BUYER: playground ─────────────────────────────

  function mountPlayground() {
    const pg = S.pg;
    const body = document.getElementById('b-try');
    body._html = null;
    body.innerHTML = `
      <div class="pg-controls">
        <div class="field">
          <span class="visually-hidden" id="pg-svc-label">Service</span>
          <div class="seg-toggle" role="group" aria-labelledby="pg-svc-label">
            <button type="button" data-pg-svc="inference" aria-pressed="${pg.service === 'inference'}">Inference</button>
            <button type="button" data-pg-svc="query" aria-pressed="${pg.service === 'query'}">SPARQL query</button>
          </div>
        </div>
        <div class="field field-units">
          <label for="pg-units" title="maxUnits: the most units this call may use; the worst case reserved is max units × ask">Max units for this call</label>
          <input type="text" inputmode="numeric" id="pg-units" value="${esc(pg.maxUnits[pg.service])}" aria-describedby="pg-preview">
        </div>
        <button type="button" class="btn btn-primary" data-action="invoke" id="pg-run" aria-describedby="pg-run-why">Run call</button>
        <button type="button" class="btn btn-sm" data-action="probe-ceiling" title="Set the max units to the smallest value whose worst case crosses the soft ceiling">Probe soft ceiling</button>
      </div>
      <div class="hint run-why" id="pg-run-why"></div>
      <div class="field">
        <label for="pg-input" id="pg-input-label" class="wrap">${pg.service === 'query' ? 'SPARQL (runs against the seller’s marketplace graph view)' : 'Prompt (devnet stub echoes it back, metered in tokens)'}</label>
        <textarea id="pg-input" rows="4" spellcheck="false">${esc(pg.service === 'query' ? pg.sparql : pg.prompt)}</textarea>
      </div>
      <div class="preview-line" id="pg-preview"></div>
      <div class="result" id="pg-result" aria-live="polite"></div>`;
    renderPlaygroundLive();
  }

  /** Playground preview: worst case vs soft-ceiling allowance for the current inputs. */
  function playgroundEstimate() {
    const pg = S.pg;
    const st = buyerStatus();
    const meter = S.meter.data?.state ?? st?.buyer?.meter;
    const ap = activePlan();
    const policy = ap?.policy;
    let maxUnits = null;
    try {
      maxUnits = parseUnits(pg.maxUnits[pg.service]);
    } catch {
      /* invalid */
    }
    const offers = dedupeOffers(S.offers[2].data?.offers ?? []);
    const { picks } = routerPreview(offers, policy ?? null);
    let pick = picks[pg.service];
    if (!policy) {
      // No known policy: cheapest best-known live ask among offers the seller still serves.
      pick = offers
        .filter((o) => o.serviceType === pg.service)
        .map((o) => ({ o, side: sellerSide(o) }))
        .filter((x) => x.side.served !== false)
        .map((x) => ({ ...x.o, side: x.side, liveAskWei: effectiveAsk(x.o, x.side) }))
        .sort((a, b) => (a.liveAskWei < b.liveAskWei ? -1 : a.liveAskWei > b.liveAskWei ? 1 : 0))[0];
    }
    const idx = policy ? policy.buckets.findIndex((b) => b.match?.serviceType === pg.service && !b.match?.modelId) : -1;
    const bk = idx >= 0 ? meter?.buckets?.[idx] : null;
    const pb = idx >= 0 ? policy.buckets[idx] : null;
    let allowance = null;
    let remaining = null;
    if (bk) {
      remaining = W(bk.budgetWei) - W(bk.settledWei) - W(bk.reservedWei);
      allowance = remaining > 0n ? (remaining * BigInt(meter.softCeilingBps ?? 9500)) / 10000n : 0n;
    }
    const ask = pick ? W(pick.liveAskWei ?? pick.askPerUnitWei) : null;
    const worst = ask !== null && maxUnits !== null ? ask * maxUnits : null;
    const subscribed = Boolean(st?.buyer?.subscribed);
    return {
      maxUnits, pick, ask, worst, allowance, remaining, pb, policy, subscribed,
      planEpoch: st?.buyer?.epoch ?? null,
      ended: subscribed && planEnded(st?.buyer?.epoch),
      statusKnown: Boolean(S.status[2].data) && !S.status[2].error,
    };
  }

  /** Why “Run call” is disabled, or '' when it is enabled. */
  function runBlocker(e) {
    if (S.busy.invoke) return '';
    if (!S.status[2].data) return 'Buyer node unreachable — Run call is disabled until node 2 answers.';
    if (S.status[2].error) return 'Buyer node unreachable (last refresh failed) — Run call is disabled until node 2 answers again.';
    if (!e.subscribed) return 'Subscribe first (step 2): calls need an active plan on the buyer node.';
    return '';
  }

  function renderPlaygroundLive() {
    const prev = $('#pg-preview');
    if (!prev) return;
    const pg = S.pg;
    const e = playgroundEstimate();
    const bits = [];
    if (e.ended) bits.push(`<span class="warn">your plan’s epoch ${esc(String(e.planEpoch))} has ended — the seller will refuse with SETTLEMENT_CLOSED; subscribe for epoch ${esc(String(currentEpoch()))} first</span>`);
    if (e.maxUnits === null) bits.push('<span class="warn">max units must be a whole number</span>');
    else if (e.maxUnits <= 0n) bits.push('<span class="warn">max units must be greater than 0</span>');
    if (e.pick) {
      const unit = e.pick.unit;
      const stale = e.pick.side?.stale && e.pick.side?.liveAsk !== null;
      bits.push(`router would pick ${whoIdentity(e.pick.sellerIdentityId)} at ${askAmt(e.ask, unit)}${stale ? ` <span class="muted">(seller’s current ask; node 2 still lists ${askAmt(e.pick.askPerUnitWei, unit)})</span>` : ''}`);
    } else bits.push('<span class="muted">no eligible offer for this service yet</span>');
    if (e.worst !== null) bits.push(`worst case ${amt(e.worst, { unit: 'micro' })}`);
    if (e.allowance !== null) bits.push(`next-call limit ${amt(e.allowance, { unit: 'micro' })}`);
    if (e.worst !== null && e.allowance !== null && e.worst > e.allowance) bits.push('<span class="warn">will be refused locally (soft ceiling)</span>');
    if (e.pb && e.maxUnits !== null && e.maxUnits > W(e.pb.maxUnitsPerCall)) bits.push(`<span class="warn">above the bucket’s limit of ${esc(groupInt(String(e.pb.maxUnitsPerCall)))} units / call</span>`);
    if (pg.service === 'inference') {
      const t = tokensOf(pg.prompt);
      bits.push(`prompt ≈ ${t} tokens (served ≈ prompt + echo, capped at the max units)`);
      if (e.maxUnits !== null && BigInt(t) > e.maxUnits) bits.push('<span class="warn">the prompt alone exceeds the max units</span>');
    } else {
      const bytes = new TextEncoder().encode(pg.sparql).length;
      bits.push(`query meters ${10 + Math.ceil(bytes / 100)} units + 1 per result row`);
    }
    setHtml(prev, bits.map((b) => `<span>${b}</span>`).join(''));
    const blocker = runBlocker(e);
    const run = $('#pg-run');
    if (run) {
      run.disabled = Boolean(S.busy.invoke) || Boolean(blocker);
      run.innerHTML = S.busy.invoke ? '<span class="spin"></span>Calling…' : 'Run call';
    }
    const why = $('#pg-run-why');
    if (why) why.innerHTML = blocker ? `<span class="warn-text">${esc(blocker)}</span>` : '';
    const res = $('#pg-result');
    if (res) setHtml(res, renderInvokeResult());
  }

  function renderInvokeResult() {
    const last = S.results.invoke;
    if (!last) return emptyBox('No call yet', 'Pick a service, set the max units, and run a call. The result, metered units, cost, serving seller and the seller-signed receipt appear here.');
    const r = last.r;
    if (!r.ok) return errorBox(r, { ctx: { kind: 'invoke', maxUnitsPerCall: last.maxUnitsPerCall } });
    const j = r.json ?? {};
    const units = W(j.servedUnits);
    const cost = W(j.costWei);
    const ask = W(j.authorization?.askPerUnitWei);
    const offer = (S.offers[2].data?.offers ?? []).find((o) => String(o.offeringId).toLowerCase() === String(j.authorization?.offeringId ?? '').toLowerCase());
    const unitName = offer?.unit ?? UNIT_OF_SERVICE[last.svc];
    const unitWord = last.svc === 'query' ? 'query units' : 'tokens';
    const result = j.result ?? {};
    let output;
    if (last.svc === 'query') {
      const inner = result?.result ?? result;
      const bindings = Array.isArray(inner?.bindings) ? inner.bindings : null;
      if (bindings && bindings.length > 0) {
        const cols = [...new Set(bindings.flatMap((b) => Object.keys(b)))];
        output = `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>?${esc(c)}</th>`).join('')}</tr></thead><tbody>${bindings.map((b) => `<tr>${cols.map((c) => `<td class="hex">${esc(typeof b[c] === 'string' ? b[c] : JSON.stringify(b[c] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } else if (bindings) {
        output = emptyBox('Query returned no rows', 'Still metered: the static schedule charges 10 + ⌈bytes/100⌉ units per query.');
      } else {
        output = `<pre class="result-output">${esc(JSON.stringify(inner, null, 2))}</pre>`;
      }
    } else {
      output = `<pre class="result-output">${esc(result?.output ?? JSON.stringify(result, null, 2))}</pre>${result?.truncated ? '<p class="hint">Output truncated so prompt + output fits the max units.</p>' : ''}`;
    }
    const rc = j.receipt ?? {};
    const au = j.authorization ?? {};
    // The preview predicted a seller from discovered (possibly stale) asks;
    // the router decided on live quotes. Say so when they disagree.
    let mismatch = '';
    const p = last.predicted;
    const servedId = W(j.seller?.identityId).toString();
    if (p && p.identityId !== servedId) {
      mismatch = warnBox('Served by a different seller than the preview predicted', `The preview expected ${whoIdentity(p.identityId)} at ${askAmt(p.ask, unitName)}; the live quotes routed to ${whoIdentity(servedId)} at ${askAmt(ask, unitName)}. The router always ranks on live quotes — a discovered ask can be stale when a seller’s update has not reached the buyer node.`);
    } else if (p && W(p.ask) !== ask) {
      mismatch = infoBox('Live ask differed from the preview', `The preview used ${askAmt(p.ask, unitName)}; the seller’s live quote was ${askAmt(ask, unitName)}, which is what you were charged.`);
    }
    return `${okBox(`Served by ${whoIdentity(j.seller?.identityId)}`, `${esc(groupInt(units.toString()))} ${unitWord} × ${askAmt(ask, unitName)} = <strong>${amt(cost, { unit: 'micro' })}</strong> · receipt verified by your node`)}
      ${mismatch}
      <div class="stats mt-3">
        <div class="stat"><div class="k">Served units</div><div class="v num">${esc(groupInt(units.toString()))}</div><div class="s">of ${esc(groupInt(String(au.maxUnits ?? '?')))} authorized</div></div>
        <div class="stat"><div class="k">Cost</div><div class="v">${amt(cost, { unit: 'micro' })}</div><div class="s">served units × ask</div></div>
        <div class="stat"><div class="k">Worst case reserved</div><div class="v">${amt(W(au.maxUnits) * ask, { unit: 'micro' })}</div><div class="s">max units × ask</div></div>
      </div>
      ${output}
      <details class="receipt"><summary>Receipt &amp; authorization</summary>
        <dl class="kv">
          <dt>authDigest</dt><dd class="hex">${esc(rc.authDigest)}</dd>
          <dt>resultCommitment</dt><dd class="hex">${esc(rc.resultCommitment)} <span class="muted">(sha256 of the result bytes)</span></dd>
          <dt>Seller signature</dt><dd class="hex">${esc(rc.sellerSig)}</dd>
          <dt>Signed by</dt><dd>${whoAddress(j.seller?.address)}</dd>
          <dt>Receipt value</dt><dd>${amt(rc.receiptValueWei, { unit: 'micro' })}</dd>
          <dt>Call id</dt><dd class="hex">${esc(au.callId)}</dd>
          <dt>Epoch</dt><dd>${esc(String(au.epoch ?? ''))}</dd>
          <dt>Offering id</dt><dd class="hex">${esc(au.offeringId)}</dd>
          <dt>Authorized</dt><dd>${esc(groupInt(String(au.maxUnits ?? '')))} units at ${askAmt(au.askPerUnitWei, unitName)}</dd>
          <dt>Expires</dt><dd>${esc(fmtTime(au.expiry))} (chain time)</dd>
          <dt>Session-key sig</dt><dd class="hex">${esc(au.signature)}</dd>
          <dt>Buyer (funding)</dt><dd>${whoAddress(au.buyer)}</dd>
        </dl>
      </details>`;
  }

  const HISTORY_KEY = 'mkt-console-history';
  const saveHistory = () => {
    S.history = S.history.slice(0, 50);
    session.set(HISTORY_KEY, S.history);
  };

  async function doInvoke() {
    const pg = S.pg;
    let maxUnits;
    try {
      maxUnits = parseUnits(pg.maxUnits[pg.service]);
      if (maxUnits <= 0n) throw new Error('must be greater than 0');
    } catch (e) {
      toast(`Max units for this call: ${esc(e.message)}`, 'warn');
      return;
    }
    const text = pg.service === 'query' ? pg.sparql : pg.prompt;
    if (!text.trim()) {
      toast(pg.service === 'query' ? 'Enter a SPARQL query.' : 'Enter a prompt.', 'warn');
      return;
    }
    const est = playgroundEstimate();
    const predicted = est.pick ? { identityId: W(est.pick.sellerIdentityId).toString(), ask: W(est.ask).toString() } : null;
    S.busy.invoke = true;
    renderPlaygroundLive();
    const svc = pg.service;
    // Recorded as “pending” before the request: if the page unloads mid-call,
    // the next load shows “outcome unknown” instead of a false failure.
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      chainAt: chainNowSec(),
      svc,
      maxUnits: maxUnits.toString(),
      state: 'pending',
    };
    S.history.unshift(entry);
    saveHistory();
    renderHistory();
    const r = await api(nodePath(2, '/invoke'), {
      method: 'POST',
      body: { serviceType: svc, payload: svc === 'query' ? { sparql: text } : { prompt: text }, maxUnits: maxUnits.toString() },
      // Longer than the console server's own 180 s proxy timeout, so a slow
      // node is reported by the server (504) rather than by a browser abort.
      timeoutMs: 200_000,
    });
    if (S.unloading) return; // the page is going away: keep the entry “pending”
    S.busy.invoke = false;
    S.results.invoke = { r, svc, at: Date.now(), predicted, maxUnitsPerCall: est.pb?.maxUnitsPerCall ?? null };
    const x = r.ok ? null : explain(r, { kind: 'invoke' });
    Object.assign(entry, {
      state: r.ok ? 'ok' : x.unknown ? 'unknown' : 'failed',
      code: r.ok ? null : (r.json?.code ? `${r.json.code}${r.json.reason ? ` · ${r.json.reason}` : ''}` : x.code ?? `HTTP ${r.status}`),
      title: r.ok ? null : x.title,
      seller: r.ok ? String(r.json?.seller?.identityId ?? '') : null,
      units: r.ok ? String(r.json?.servedUnits ?? '') : null,
      costWei: r.ok ? String(r.json?.costWei ?? '0') : null,
    });
    if (r.ok && r.json?.authorization?.offeringId) {
      S.observed[`${String(r.json.authorization.offeringId).toLowerCase()}:${W(r.json.seller?.identityId)}`] = { ask: String(r.json.authorization.askPerUnitWei), at: Date.now() };
      session.set('mkt-console-observed', S.observed);
    }
    saveHistory();
    await refreshAll();
  }

  function probeCeiling() {
    const e = playgroundEstimate();
    if (!e.subscribed || e.allowance === null || !e.ask) {
      toast('Subscribe and wait for offers first — the probe needs your bucket and the router’s ask.', 'warn');
      return;
    }
    const units = e.allowance / e.ask + 1n;
    if (e.pb && units > W(e.pb.maxUnitsPerCall)) {
      toast(`A single call cannot cross the soft ceiling: it would need ${groupInt(units.toString())} units, above this bucket’s limit of ${groupInt(String(e.pb.maxUnitsPerCall))} units / call. Spend more first, or subscribe with a smaller budget.`, 'warn');
      return;
    }
    S.pg.maxUnits[S.pg.service] = units.toString();
    const input = $('#pg-units');
    if (input) input.value = units.toString();
    renderPlaygroundLive();
    toast(`Max units set to ${groupInt(units.toString())}: worst case ${amt(units * e.ask, { unit: 'micro' })} crosses the ${amt(e.allowance, { unit: 'micro' })} next-call limit. Run the call to see the refusal.`);
  }

  function renderHistory() {
    const h = S.history;
    if (h.length === 0) {
      setBody('history', emptyBox('No calls in this browser session', 'Every call you run in “Try it” is listed here with its seller, metered units, cost or refusal code.'));
      return;
    }
    const ok = h.filter((x) => x.state === 'ok');
    const unknown = h.filter((x) => x.state === 'unknown' || x.state === 'pending');
    const total = ok.reduce((s, x) => s + W(x.costWei), 0n);
    setMeta('history', `${h.length} call${h.length === 1 ? '' : 's'} · ${amt(total, { unit: 'micro' })} confirmed${unknown.length ? ` · ${unknown.length} outcome unknown` : ''}`);
    const outcome = (x) => {
      if (x.state === 'ok') return whoIdentity(x.seller);
      if (x.state === 'pending') return S.busy.invoke ? '<span class="tag tag-info">in progress</span>' : '<span class="tag tag-warn">outcome unknown</span><div class="why">no answer recorded — check the meter</div>';
      if (x.state === 'unknown') return `<span class="tag tag-warn">outcome unknown</span><div class="why">${esc(x.title ?? 'no answer')} — check the meter</div>`;
      return `<span class="code-chip">${esc(x.code)}</span><div class="why">${esc(x.title ?? '')}</div>`;
    };
    setBody('history', `<div class="table-wrap"><table class="table-cards">
      <thead><tr><th>Chain time</th><th>Service</th><th>Outcome</th><th class="r">Units</th><th class="r">Cost</th></tr></thead>
      <tbody>${h.map((x) => `<tr>
        <td class="nowrap" data-label="Chain time" title="Browser wall clock: ${esc(new Date(x.at).toISOString().replace('T', ' ').slice(0, 19))} UTC">${x.chainAt ? esc(fmtClock(x.chainAt).replace(' UTC', '')) : esc(new Date(x.at).toISOString().replace('T', ' ').slice(0, 19))}</td>
        <td data-label="Service">${esc(SERVICE_LABEL[x.svc] ?? x.svc)}</td>
        <td data-label="Outcome">${outcome(x)}</td>
        <td class="r" data-label="Units">${x.state === 'ok' ? esc(groupInt(x.units)) : `<span class="muted">≤ ${esc(groupInt(x.maxUnits))}</span>`}</td>
        <td class="r" data-label="Cost">${x.state === 'ok' ? amt(x.costWei, { unit: 'micro' }) : x.state === 'failed' ? '—' : x.state === 'pending' && S.busy.invoke ? '<span class="muted">…</span>' : '<span class="muted">unknown</span>'}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="hint">Times are chain time (UTC), like the rest of the page; hover for the browser’s wall-clock time. Only calls this browser tab ran are listed.</p>`);
  }

  // ───────────────────────────── BUYER: settlement ─────────────────────────────

  /** Panel body when the epoch to show is unknown (chain unreachable) — never an endless skeleton. */
  function epochUnavailable(id) {
    if (S.chain.loaded && !S.chain.data) {
      setBody(id, errorBox(S.chain.error, { title: 'Chain state unavailable', retry: true }));
      return true;
    }
    return false;
  }

  function renderBuyerSettlement() {
    const e = viewEpoch();
    if (e === null) {
      epochUnavailable('settle');
      return;
    }
    const es = S.epochs[String(e)];
    if (!es?.loaded) return;
    setMeta('settle', `epoch ${esc(String(e))} · ${since(es.at, es)}`);
    if (!es.data) {
      setBody('settle', errorBox(es.error, { retry: true }));
      return;
    }
    const d = es.data;
    const bucket = d.buckets.find((b) => b.buyerNode === 2);
    if (!bucket) {
      setBody('settle', `${staleBanner(es)}${emptyBox(`No bucket for epoch ${e}`, 'Node 2 has not funded this epoch. Subscribe to create a bucket; it settles after the epoch’s settlement deadline.')}`);
      return;
    }
    const unit = pickUnit(bucket.funded, bucket.totalClaimed, ...bucket.sellers.map((s) => s.claimed));
    const past = d.pastDeadline ?? d.settled;
    const finalizeR = S.results.finalize;
    const parts = [staleBanner(es)];
    parts.push(`<p class="lede">${past
      ? 'The settlement deadline has passed: no more receipts can land. Finalizing caps every seller’s claims to your funding — pro-rata, with no submission-order priority — and feeds the sellers’ epoch rewards.'
      : `Receipts are still open: sellers can submit claims until the settlement deadline (${esc(fmtTime(d.deadline))}, ${countdown(d.deadline, { future: 'in {}', past: 'passed {} ago' })}). After it, anyone can finalize the bucket.`}</p>`);
    const status = bucket.finalized
      ? ['<span class="ok-text">Finalized</span>', 'rewards can be claimed once every bucket of the epoch is']
      : past
        ? ['<span class="warn-text">Ready to finalize</span>', 'receipts closed · finalize to settle']
        : ['Receipts open', `deadline ${countdown(d.deadline, { future: 'in {}', past: 'passed {} ago' })}`];
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">Funded</div><div class="v">${amt(bucket.funded, { unit })}</div><div class="s">non-refundable</div></div>
      <div class="stat"><div class="k">Claimed by sellers</div><div class="v">${amt(bucket.totalClaimed, { unit })}</div><div class="s">${pctOf(bucket.totalClaimed, bucket.funded)} of funding</div></div>
      <div class="stat"><div class="k">${bucket.finalized ? 'Finalized' : 'If finalized now'}</div><div class="v">${amt(bucket.finalized ? bucket.totalFinalized : bucket.sellers.reduce((s, x) => s + W(x.finalizedValue), 0n), { unit })}</div><div class="s">${bucket.overClaimed ? 'over-claimed → pro-rata' : 'claims fit the funding'}</div></div>
      <div class="stat"><div class="k">Status</div><div class="v">${status[0]}</div><div class="s">${status[1]}</div></div>
    </div>`);
    if (bucket.sellers.length === 0) {
      parts.push(emptyBox('No seller claims yet', 'Claims appear once sellers flush their signed receipts on-chain (sellers auto-submit ~15 s after serving, or use “Flush receipts now” in a seller view).'));
    } else {
      parts.push(`<div class="table-wrap"><table class="table-cards">
        <thead><tr><th>Seller</th><th class="r">Claimed</th><th class="r">Share</th><th class="r">${bucket.finalized ? 'Finalized' : 'Pro-rata if finalized now'}</th></tr></thead>
        <tbody>${bucket.sellers.map((s) => `<tr>
          <td data-label="Seller">${whoIdentity(s.identityId)}</td>
          <td class="r" data-label="Claimed">${amt(s.claimed, { unit })}</td>
          <td class="r" data-label="Share">${pctOf(s.claimed, bucket.totalClaimed)}<div class="bar-mini"><span data-w="${widthPct(s.claimed, bucket.totalClaimed)}"></span></div></td>
          <td class="r" data-label="${bucket.finalized ? 'Finalized' : 'If finalized now'}">${amt(s.finalizedValue, { unit })}</td>
        </tr>`).join('')}</tbody></table></div>
        <p class="hint">Amounts in ${unit === 'micro' ? 'µTRAC (1 µTRAC = 0.000001 TRAC)' : 'TRAC'}.</p>`);
      if (bucket.overClaimed) parts.push(`<p class="hint">Pro-rata: finalized = claimed × funded ÷ total claimed (rounded down). Residue ${amt(bucket.residue, { unit })} stays in the pool.</p>`);
    }
    if (finalizeR && finalizeR.epoch === String(e)) {
      parts.push(finalizeR.r.ok ? okBox('Finalize transaction sent', `tx <span class="hex">${esc(finalizeR.r.json?.txHash ?? '')}</span>`) : errorBox(finalizeR.r));
    }
    const can = bucket.canFinalize;
    const hint = bucket.finalized
      ? 'Already finalized.'
      : can
        ? 'Node 2 sends the finalize transaction (anyone may finalize after the deadline).'
        : `Enabled after the settlement deadline (${countdown(d.deadline, { future: 'in {}', past: 'passed {} ago' })}).${ttHint()}`;
    parts.push(`<div class="row mt-3">
      <button type="button" class="btn btn-primary" data-action="finalize" aria-describedby="finalize-hint" ${!can || S.busy.finalize ? 'disabled' : ''}>${S.busy.finalize ? '<span class="spin"></span>Finalizing…' : 'Finalize my bucket'}</button>
      <span class="hint" id="finalize-hint" title="${can ? 'finalizeBucket(buyer, epoch) on the Marketplace contract' : ''}">${hint}</span>
    </div>`);
    setBody('settle', parts.join(''));
  }

  async function doFinalize(buyerAddress, fromNode = 2) {
    const e = viewEpoch();
    S.busy.finalize = true;
    render();
    const body = { action: 'finalize', epoch: String(e) };
    if (buyerAddress) body.buyer = buyerAddress;
    const r = await api(nodePath(fromNode, '/settle'), { method: 'POST', body, timeoutMs: 120_000 });
    S.busy.finalize = false;
    S.results.finalize = { r, epoch: String(e) };
    if (r.ok) toast(`Bucket finalized for epoch ${esc(String(e))}.`);
    else toast(`Finalize failed: ${esc(explain(r).title)}`, 'error');
    await refreshAll({ full: true });
  }

  // ───────────────────────────── SELLER: status ─────────────────────────────

  function renderSellerStatus(n) {
    const st = S.status[n];
    if (!st.loaded) return;
    if (!st.data) {
      setBody('seller', errorBox(st.error, { retry: true }));
      return;
    }
    setMeta('seller', since(st.at, st));
    const s = st.data;
    const node = nodeInfo(n);
    const sv = s.seller ?? {};
    const parts = [staleBanner(st, S.nodes)];
    if (!s.enabled) {
      setBody('seller', warnBox(`Marketplace disabled on node ${n}`, 'Enable <code>marketplace.enabled</code> in the node config and restart the devnet.'));
      return;
    }
    if (s.degraded) parts.push(warnBox('Marketplace degraded', esc(s.degraded)));
    if (!s.sellerReady) parts.push(warnBox('Seller role unavailable', 'This node has no operational signing key, so it cannot sign receipts.'));
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">Offerings served</div><div class="v num">${esc(String(sv.offerings ?? 0))}</div><div class="s">${s.sellerReady ? 'answering quotes' : 'seller off'}</div></div>
      <div class="stat"><div class="k">Pending receipts</div><div class="v num">${esc(String(sv.pendingReceipts ?? 0))}</div><div class="s">signed, not yet on-chain</div></div>
      <div class="stat"><div class="k">Submitted claims</div><div class="v num">${esc(String(sv.submittedClaims ?? 0))}</div><div class="s">since node start</div></div>
    </div>`);
    const extra = (node?.opWallets?.length ?? 0) > 1 ? ` <span class="muted">+${node.opWallets.length - 1} more</span>` : '';
    // /chain/nodes (identity, wallets, online probe) needs the chain: when it
    // never loaded, say "unknown" instead of claiming offline / no identity.
    const chainUnknown = !node && S.nodes.loaded && !S.nodes.data;
    if (chainUnknown) parts.push(warnBox('Identity and wallets unknown', `The console could not read them from the chain (${esc(explain(S.nodes.error).title)}). The node itself is answering — the figures above come from its API.`));
    const onlineTag = chainUnknown
      ? '<span class="tag tag-ok">answering</span>'
      : node?.online ? '<span class="tag tag-ok">online</span>' : '<span class="tag tag-danger">offline</span>';
    const identity = chainUnknown
      ? '<span class="muted">unknown (chain unreachable)</span>'
      : W(node?.identityId) > 0n ? `<strong>${esc(String(node.identityId))}</strong>` : '<span class="warn-text">no on-chain identity</span>';
    parts.push(`<dl class="kv">
      <dt>Node</dt><dd>${whoNode(n)} ${onlineTag} <span class="muted">:${esc(String(node?.apiPort ?? 9200 + n))}</span></dd>
      <dt>Identity</dt><dd>${identity}</dd>
      <dt>Peer id</dt><dd class="hex">${esc(node?.peerId ?? (chainUnknown ? 'unknown' : '—'))}</dd>
      <dt>Op wallet</dt><dd><span class="hex">${esc(node?.primaryWallet ?? (chainUnknown ? 'unknown' : '—'))}</span>${extra}</dd>
      <dt>TRAC (op wallets)</dt><dd>${node ? amt(node.tracWei, { unit: 'trac' }) : chainUnknown ? '<span class="muted">unknown</span>' : '—'}</dd>
    </dl>`);
    setBody('seller', parts.join(''));
  }

  // ───────────────────────────── SELLER: offerings editor ─────────────────────────────

  function initEditor(n, { force = false } = {}) {
    if (S.editors[n] && !force) return S.editors[n];
    const remembered = S.cstate.data?.offerings?.[String(n)];
    let rows = null;
    let source = 'none';
    const myId = W(nodeInfo(n)?.identityId);
    const own = dedupeOffers(S.offers[n].data?.offers ?? []).filter((o) => myId > 0n && W(o.sellerIdentityId) === myId);
    if (remembered?.offerings) {
      // A published set is mirrored by this node's own graph view; a different
      // ask there means the node was republished outside this console since.
      const graphAsk = (localId) => {
        const hits = remembered.publish !== false ? own.filter((o) => localIdOf(o.offerId) === localId) : [];
        return hits.length === 1 ? W(hits[0].askPerUnitWei) : null;
      };
      source = 'console';
      rows = remembered.offerings.map((o) => {
        const ask = graphAsk(o.offeringLocalId) ?? W(o.askPerUnitWei);
        if (ask !== W(o.askPerUnitWei)) source = 'console+graph';
        return {
          id: o.offeringLocalId,
          serviceType: o.serviceType,
          unit: o.unit,
          modelId: o.modelId ?? '',
          askMicro: decimal(ask, 12).replace(/,/g, ''),
        };
      });
    } else if (own.length) {
      const byId = new Map();
      for (const o of own) byId.set(localIdOf(o.offerId) || o.offeringId, o);
      rows = [...byId.entries()].map(([id, o]) => ({ id, serviceType: o.serviceType, unit: o.unit, modelId: o.modelId ?? '', askMicro: decimal(W(o.askPerUnitWei), 12).replace(/,/g, '') }));
      source = 'graph';
    }
    // A published set waits for the graph view too (its asks may be newer).
    const ready = S.offers[n].loaded || (Boolean(remembered) && remembered.publish === false);
    S.editors[n] = { rows: rows ?? [], source, dirty: false, touched: false, initialized: S.cstate.loaded && ready };
    return S.editors[n];
  }

  function editorErrors(ed) {
    const errors = {};
    const seen = new Set();
    ed.rows.forEach((r, i) => {
      const id = r.id.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) errors[`${i}.id`] = 'letters, digits, . _ - (1–64)';
      else if (seen.has(id)) errors[`${i}.id`] = 'duplicate id';
      seen.add(id);
      try {
        const v = parseMicro(r.askMicro);
        if (v <= 0n) throw new Error('must be > 0 (zero-ask claims revert)');
        if (v >= UINT96) throw new Error('too large');
      } catch (e) {
        errors[`${i}.ask`] = e.message;
      }
    });
    return errors;
  }

  function mountOfferings(n) {
    const ed = initEditor(n);
    const body = document.getElementById('b-offerings');
    if (!body) return;
    body._html = null;
    const rows = ed.rows.map((r, i) => `
      <div class="offering-row">
        <div class="field"><label for="of-id-${i}">Offering id</label><input type="text" id="of-id-${i}" data-of="id" data-i="${i}" value="${esc(r.id)}" autocomplete="off"><div class="hint danger-text" data-of-err="${i}.id"></div></div>
        <div class="field"><label for="of-svc-${i}">Service</label><select id="of-svc-${i}" data-of="serviceType" data-i="${i}">${SERVICE_TYPES.map((t) => `<option value="${t}"${t === r.serviceType ? ' selected' : ''}>${esc(SERVICE_LABEL[t])}</option>`).join('')}</select></div>
        <div class="field"><label for="of-unit-${i}">Unit</label><select id="of-unit-${i}" data-of="unit" data-i="${i}">${UNITS.map((u) => `<option value="${u}"${u === r.unit ? ' selected' : ''}>${esc(UNIT_LABEL[u])}</option>`).join('')}</select></div>
        <div class="field"><label for="of-model-${i}">Model</label><input type="text" id="of-model-${i}" data-of="modelId" data-i="${i}" value="${esc(r.modelId)}" placeholder="optional"></div>
        <div class="field"><label for="of-ask-${i}">Ask <span class="unit">µTRAC/unit</span></label><input type="text" inputmode="decimal" id="of-ask-${i}" data-of="askMicro" data-i="${i}" value="${esc(r.askMicro)}"><div class="wei-preview" data-of-prev="${i}"></div><div class="hint danger-text" data-of-err="${i}.ask"></div></div>
        <button type="button" class="btn btn-ghost btn-sm rm" data-action="of-rm" data-arg="${i}" aria-label="Remove offering ${esc(r.id || i + 1)}" title="Remove offering">×</button>
      </div>`).join('');
    body.innerHTML = `
      <p class="lede">Each offering is published as a Knowledge Asset into the shared <code>marketplace</code> context graph. Inference uses the deterministic devnet stub; queries run against this node’s marketplace graph view. Removing an offering stops this node from quoting it (buyers skip it), though its KA stays in the graph.</p>
      ${ed.rows.length === 0 ? emptyBox('No offerings on this node', 'Add one, or load the devnet defaults used by the e2e suite.') : `<div class="bucket-rows">${rows}</div>`}
      <div class="row mt-3">
        <button type="button" class="btn btn-sm" data-action="of-add">Add offering</button>
        ${DEVNET_OFFERINGS[n] ? '<button type="button" class="btn btn-sm" data-action="of-defaults">Load devnet defaults</button>' : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-action="of-reload">Reset to published</button>
      </div>
      <div id="of-live"></div>
      <div id="of-result" aria-live="polite"></div>`;
    const panelEl = document.getElementById('p-offerings');
    if (!panelEl.querySelector('.panel-f')) {
      panelEl.insertAdjacentHTML('beforeend', `<div class="panel-f"><span class="grow hint" id="of-note"></span><button type="button" class="btn btn-primary" data-action="publish" id="of-submit">Publish offerings</button></div>`);
    }
    updateOfferingPreviews(n);
    renderOfferingsLive(n);
  }

  function updateOfferingPreviews(n) {
    const ed = S.editors[n];
    if (!ed) return;
    const errors = editorErrors(ed);
    ed.rows.forEach((r, i) => {
      const el = $(`[data-of-prev="${i}"]`);
      if (el) {
        try {
          el.textContent = `= ${groupInt(parseMicro(r.askMicro).toString())} wei/unit`;
        } catch {
          el.textContent = '';
        }
      }
    });
    for (const el of $$('[data-of-err]')) el.textContent = ed.touched ? (errors[el.dataset.ofErr] ?? '') : '';
    for (const el of $$('[data-of]')) {
      const key = `${el.dataset.i}.${el.dataset.of === 'askMicro' ? 'ask' : el.dataset.of}`;
      el.classList.toggle('is-invalid', Boolean(ed.touched && errors[key]));
    }
  }

  function renderOfferingsLive(n) {
    const ed = S.editors[n];
    if (!ed) return;
    if (!ed.initialized && !ed.dirty && S.cstate.loaded && S.offers[n].loaded) {
      initEditor(n, { force: true });
      S.editors[n].initialized = true;
      mountOfferings(n);
      return;
    }
    const st = S.status[n].data;
    const served = st?.seller?.offerings;
    const note = $('#of-note');
    if (note) {
      note.textContent = ed.dirty
        ? 'Unpublished changes.'
        : ed.source === 'console' ? `Matches the set the console last published.`
          : ed.source === 'console+graph' ? 'The set the console last published, with the asks this node has published since (outside this console).'
          : ed.source === 'graph' ? 'Loaded from this node’s view of the marketplace graph.' : '';
    }
    const btn = $('#of-submit');
    if (btn) {
      btn.disabled = Boolean(S.busy[`publish${n}`]) || st?.sellerReady === false;
      btn.innerHTML = S.busy[`publish${n}`] ? '<span class="spin"></span>Publishing…' : 'Publish offerings';
    }
    const live = $('#of-live');
    if (live) {
      const myId = W(nodeInfo(n)?.identityId);
      const o = S.offers[n];
      const buyerView = S.offers[2];
      const chainUnknown = !nodeInfo(n) && S.nodes.loaded && !S.nodes.data;
      const remembered = S.cstate.data?.offerings?.[String(n)];
      const publishedAt = remembered?.at ? Date.parse(remembered.at) : null;
      let graphHtml = '';
      let propagationWarn = '';
      if (chainUnknown) {
        graphHtml = `<p class="hint">Can’t tell which offers are this node’s: its on-chain identity is unknown (chain unreachable).</p>`;
      } else if (o.data) {
        const own = dedupeOffers(o.data.offers).filter((x) => myId > 0n && W(x.sellerIdentityId) === myId);
        if (own.length) {
          // Propagation check: does the BUYER node (2) see the same ask?
          const rowsHtml = own.map((x) => {
            const seenByBuyer = (buyerView.data?.offers ?? []).filter((b) => b.offerId === x.offerId);
            let buyerCell;
            let ok = false;
            if (!buyerView.data) buyerCell = '<span class="muted">buyer view unavailable</span>';
            else if (seenByBuyer.length === 0) buyerCell = '<span class="warn-text">not discovered yet</span>';
            else if (seenByBuyer.some((b) => W(b.askPerUnitWei) === W(x.askPerUnitWei))) {
              buyerCell = '<span class="ok-text">✓ same ask</span>';
              ok = true;
            } else buyerCell = `<span class="warn-text">still sees ${seenByBuyer.map((b) => askAmt(b.askPerUnitWei, b.unit)).join(', ')}</span>`;
            const ageMin = publishedAt ? (Date.now() - publishedAt) / 60000 : null;
            if (!ok && buyerView.data && seenByBuyer.length === 0 && ageMin !== null && ageMin > 3 && !propagationWarn) {
              propagationWarn = warnBox(
                `Not discovered by the buyer after ${esc(fmtDur(Math.round(ageMin * 60)))}`,
                `Each offer is a Knowledge Asset published on-chain, and buyer node 2 usually discovers it within seconds, at most about a minute later (the first publish also anchors the <code>marketplace</code> context graph on-chain). Check that the publish succeeded, and look in <code>.devnet/node2/daemon.log</code> for <code>VM reconcile for "marketplace" failed</code> after the publish. (“SWM substrate fan-out … rejected” lines in this node’s log are expected: peers take the offer from the catalog and the chain instead.)`,
              );
            }
            if (!ok && buyerView.data && seenByBuyer.length > 0 && ageMin !== null && ageMin > 2 && !propagationWarn) {
              propagationWarn = warnBox(
                `Not propagated to the buyer after ${esc(fmtDur(Math.round(ageMin * 60)))}`,
                `The last publish from this console was ${esc(fmtDur(Math.round(ageMin * 60)))} ago, but buyer node 2 still does not see this node’s current ask. A changed ask is an on-chain update of the same offer Knowledge Asset and usually reaches the buyer within seconds, at most about a minute later. Check that the publish succeeded, and look in <code>.devnet/node2/daemon.log</code> for <code>VM reconcile for "marketplace" failed</code>. Calls still route on the seller’s <strong>live quote</strong>, so buyers pay the new ask; only their Offers table shows the old one (the console flags it as stale).`,
              );
            }
            return `<tr><td data-label="Offering"><code>${esc(localIdOf(x.offerId))}</code></td><td data-label="Service">${esc(SERVICE_LABEL[x.serviceType] ?? x.serviceType)}</td><td class="r" data-label="Ask (this node)">${askAmt(x.askPerUnitWei, x.unit)}</td><td data-label="Buyer node 2">${buyerCell}</td></tr>`;
          }).join('');
          graphHtml = `<div class="table-wrap"><table class="table-cards"><thead><tr><th>Offering</th><th>Service</th><th class="r">Ask (this node)</th><th>Buyer node 2 sees</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
        } else {
          graphHtml = '<p class="hint">None of this node’s offers are visible in its own graph view yet.</p>';
        }
      } else if (o.loaded) {
        graphHtml = `<p class="hint">Graph view unavailable: ${esc(String(o.error?.json?.error ?? o.error?.text ?? '').slice(0, 160))}</p>`;
      } else {
        graphHtml = '<p class="hint">Loading this node’s graph view…</p>';
      }
      const mismatch = served !== undefined && !ed.dirty && served !== ed.rows.length
        ? warnBox('Node and editor disagree', `The node currently serves ${esc(String(served))} offering${served === 1 ? '' : 's'} (a restart resets to the config file). Publish to make it serve the set below.`)
        : '';
      setHtml(live, `${mismatch}<div class="section-label">In the marketplace graph</div>${graphHtml}${propagationWarn}`);
    }
    const res = $('#of-result');
    if (res) {
      const r = S.results[`publish${n}`];
      setHtml(res, r ? (r.ok
        ? okBox(esc(publishSummary(r.json)), `This node now serves ${esc(String(r.json?.offerings ?? 0))} offering${r.json?.offerings === 1 ? '' : 's'} and quotes the new asks right away. Whether buyer node 2 has received the KAs is tracked in “In the marketplace graph” above (usually seconds, at most about a minute).`)
        : errorBox(r)) : '');
    }
  }

  /**
   * "1 offer KA published on-chain · 1 unchanged" from a publish response: a
   * node leaves an offering whose published content is unchanged alone (no
   * transaction) and updates a changed one in place.
   */
  function publishSummary(json) {
    const assets = Array.isArray(json?.assets) ? json.assets : null;
    if (!assets) {
      const count = json?.published?.length ?? 0;
      return `${count} offer KA${count === 1 ? '' : 's'} published`;
    }
    const published = assets.filter((a) => a.outcome !== 'unchanged').length;
    const unchanged = assets.length - published;
    const parts = [];
    if (published > 0 || unchanged === 0) parts.push(`${published} offer KA${published === 1 ? '' : 's'} published on-chain`);
    if (unchanged > 0) parts.push(`${unchanged} unchanged (no transaction)`);
    return parts.join(' · ');
  }

  async function doPublish(n) {
    const ed = S.editors[n];
    ed.touched = true;
    const errors = editorErrors(ed);
    updateOfferingPreviews(n);
    if (Object.keys(errors).length > 0) {
      toast('Fix the highlighted offering fields first.', 'warn');
      return;
    }
    const offerings = ed.rows.map((r) => ({
      offeringLocalId: r.id.trim(),
      serviceType: r.serviceType,
      unit: r.unit,
      ...(r.modelId.trim() ? { modelId: r.modelId.trim() } : {}),
      askPerUnitWei: parseMicro(r.askMicro).toString(),
    }));
    S.busy[`publish${n}`] = true;
    renderOfferingsLive(n);
    const r = await api(nodePath(n, '/seller/offerings'), { method: 'POST', body: { offerings, publish: true }, timeoutMs: 180_000 });
    S.busy[`publish${n}`] = false;
    S.results[`publish${n}`] = r;
    if (r.ok) {
      ed.dirty = false;
      ed.source = 'console';
      toast(`Node ${n}: ${esc(publishSummary(r.json))}.`);
    }
    await refreshAll({ full: true });
  }

  // ───────────────────────────── SELLER: receipts ─────────────────────────────

  function renderReceipts(n) {
    const st = S.status[n];
    if (!st.loaded) return;
    if (!st.data) {
      setBody('receipts', errorBox(st.error, { retry: true }));
      return;
    }
    const sv = st.data.seller ?? {};
    const r = S.results[`flush${n}`];
    const parts = [staleBanner(st), `<p class="lede">Every served call leaves a seller-signed receipt. The node batches them and submits claims on-chain automatically (~15 s after the oldest pending receipt); flush to submit right away.</p>
      <div class="stats">
        <div class="stat"><div class="k">Pending</div><div class="v num">${esc(String(sv.pendingReceipts ?? 0))}</div><div class="s">waiting for a batch</div></div>
        <div class="stat"><div class="k">Submitted</div><div class="v num">${esc(String(sv.submittedClaims ?? 0))}</div><div class="s">claims since node start</div></div>
      </div>`];
    if (r) {
      if (r.ok) {
        const j = r.json ?? {};
        const errs = Array.isArray(j.errors) ? j.errors : [];
        const box = (W(j.failedClaims) > 0n || errs.length) ? warnBox : okBox;
        parts.push(box(`Flushed: ${esc(String(j.batches ?? 0))} batch${j.batches === 1 ? '' : 'es'}, ${esc(String(j.claims ?? 0))} claim${j.claims === 1 ? '' : 's'}`, `requeued ${esc(String(j.requeuedClaims ?? 0))} · failed ${esc(String(j.failedClaims ?? 0))}${errs.length ? `<ul>${errs.map((e) => `<li class="hex">${esc(e)}</li>`).join('')}</ul>` : ''}${W(j.batches) === 0n ? ' · nothing was pending (receipts may already have auto-submitted)' : ''}`));
      } else {
        parts.push(errorBox(r));
      }
    }
    const idle = W(sv.pendingReceipts) === 0n && W(sv.submittedClaims) === 0n && !myClaimsInView(n);
    if (idle) parts.push(servedNothingHint(n));
    parts.push(`<div class="row mt-3"><button type="button" class="btn btn-primary" data-action="flush" aria-describedby="flush-hint" ${S.busy[`flush${n}`] || !st.data.sellerReady ? 'disabled' : ''}>${S.busy[`flush${n}`] ? '<span class="spin"></span>Flushing…' : 'Flush receipts now'}</button>
      <span class="hint" id="flush-hint">${st.data.sellerReady ? (W(sv.pendingReceipts) === 0n ? 'Nothing pending right now; flushing is harmless.' : `${esc(String(sv.pendingReceipts))} receipt(s) waiting.`) : 'Seller role unavailable on this node.'}</span></div>`);
    setBody('receipts', parts.join(''));
  }

  /** Does this seller have any claim in the viewed epoch? */
  function myClaimsInView(n) {
    const e = viewEpoch();
    const d = e === null ? null : S.epochs[String(e)]?.data;
    const myId = W(nodeInfo(n)?.identityId);
    if (!d || myId === 0n) return false;
    return d.buckets.some((b) => b.sellers.some((x) => W(x.identityId) === myId && W(x.claimed) > 0n));
  }

  /**
   * Why a seller has served nothing (the default walkthrough for Seller B):
   * the router picks the cheapest eligible live ask per service.
   */
  function servedNothingHint(n) {
    const myId = W(nodeInfo(n)?.identityId);
    const offers = dedupeOffers(S.offers[2].data?.offers ?? []);
    const mine = offers.filter((o) => myId > 0n && W(o.sellerIdentityId) === myId);
    const lines = [];
    for (const o of mine) {
      const myAsk = effectiveAsk(o);
      const cheaper = offers
        .filter((x) => x.serviceType === o.serviceType && W(x.sellerIdentityId) !== myId && sellerSide(x).served !== false)
        .map((x) => ({ x, ask: effectiveAsk(x) }))
        .filter((c) => c.ask < myAsk || (c.ask === myAsk && String(c.x.sellerPeerId) < String(o.sellerPeerId)))
        .sort((a, b) => (a.ask < b.ask ? -1 : a.ask > b.ask ? 1 : 0))[0];
      if (cheaper) {
        lines.push(`<li>${esc(SERVICE_LABEL[o.serviceType] ?? o.serviceType)}: ${whoIdentity(cheaper.x.sellerIdentityId)} asks ${askAmt(cheaper.ask, o.unit)}, below this node’s ${askAmt(myAsk, o.unit)}, so the buyer’s router picks it.</li>`);
      }
    }
    const body = lines.length
      ? `<ul>${lines.join('')}</ul><p>To route calls here: in the <strong>Buyer</strong> tab, tick the cheaper seller in the Subscribe deny list and fund the plan (“Add funds &amp; replace plan”), or publish a lower ask in <strong>Offerings</strong>.</p>`
      : '<p>No buyer call has reached this node yet. Run a call from the <strong>Buyer</strong> tab’s “Try it”; the router picks the cheapest eligible live ask per service.</p>';
    return infoBox('This node has not served any call yet', body);
  }

  async function doFlush(n) {
    S.busy[`flush${n}`] = true;
    render();
    const r = await api(nodePath(n, '/settle'), { method: 'POST', body: { action: 'flush-receipts' }, timeoutMs: 120_000 });
    S.busy[`flush${n}`] = false;
    S.results[`flush${n}`] = r;
    if (r.ok) toast(`Flush: ${esc(String(r.json?.claims ?? 0))} claim(s) in ${esc(String(r.json?.batches ?? 0))} batch(es).`);
    else toast(`Flush failed: ${esc(explain(r).title)}`, 'error');
    await refreshAll({ full: true });
  }

  // ───────────────────────────── SELLER: claims ─────────────────────────────

  function renderClaims(n) {
    const e = viewEpoch();
    if (e === null) {
      epochUnavailable('claims');
      return;
    }
    const es = S.epochs[String(e)];
    if (!es?.loaded) return;
    setMeta('claims', `epoch ${esc(String(e))} · ${since(es.at, es)}`);
    if (!es.data) {
      setBody('claims', errorBox(es.error, { retry: true }));
      return;
    }
    if (!nodeInfo(n) && S.nodes.loaded && !S.nodes.data) {
      setBody('claims', errorBox(S.nodes.error, { title: 'This node’s identity is unknown (chain unreachable)', retry: true }));
      return;
    }
    const d = es.data;
    const myId = W(nodeInfo(n)?.identityId);
    const mine = d.buckets.map((b) => ({ b, c: b.sellers.find((s) => W(s.identityId) === myId) })).filter((x) => x.c);
    const parts = [staleBanner(es, S.nodes)];
    if (mine.length === 0) {
      parts.push(emptyBox(`No claims on-chain for epoch ${e}`, 'Claims appear after a buyer’s call is served by this node and its receipt is flushed on-chain (automatically within ~15 s, or with “Flush receipts now”).'));
      const sv = S.status[n].data?.seller;
      if (sv && W(sv.submittedClaims) === 0n && W(sv.pendingReceipts) === 0n) parts.push(servedNothingHint(n));
    } else {
      const unit = pickUnit(...mine.flatMap(({ b, c }) => [c.claimed, c.qiRaw, c.finalizedValue, b.totalClaimed, b.funded]));
      const total = mine.reduce((s, x) => s + W(x.c.claimed), 0n);
      parts.push(`<div class="table-wrap"><table class="table-cards">
        <thead><tr><th>Buyer</th><th class="r">Claimed</th><th class="r">Final value</th><th>Bucket</th><th class="r">Share of bucket</th><th class="r">Stake-weighted</th></tr></thead>
        <tbody>${mine.map(({ b, c }) => `<tr>
          <td data-label="Buyer">${whoNode(nodeOfAddress(b.buyer) ?? 0).replace('node0', 'external buyer')}<div class="why hex">${esc(shortHex(b.buyer))}</div></td>
          <td class="r" data-label="Claimed">${amt(c.claimed, { unit })}</td>
          <td class="r" data-label="Final value">${amt(c.finalizedValue, { unit })}<div class="why">${b.finalized ? 'finalized' : 'pro-rata if finalized now'}${b.overClaimed ? ' · over-claimed bucket' : ''}</div></td>
          <td data-label="Bucket">${b.finalized ? '<span class="tag tag-ok">finalized</span>' : b.canFinalize ? `<button type="button" class="btn btn-sm" data-action="finalize-for" data-arg="${esc(b.buyer)}" ${S.busy.finalize ? 'disabled' : ''}>Finalize</button>` : '<span class="tag tag-info">receipts open</span>'}</td>
          <td class="r" data-label="Share of bucket">${pctOf(c.claimed, b.totalClaimed)}<div class="why">of ${amt(b.totalClaimed, { unit })} claimed · ${amt(b.funded, { unit })} funded</div></td>
          <td class="r" data-label="Stake-weighted">${amt(c.qiRaw, { unit })}<div class="why">stake factor ${W(c.claimed) > 0n ? pct18((W(c.qiRaw) * E18) / W(c.claimed), 2) : '—'}</div></td>
        </tr>`).join('')}</tbody></table></div>
        <p class="hint">Amounts in ${unit === 'micro' ? 'µTRAC' : 'TRAC'}. Total claimed this epoch: ${amt(total, { unit })}. Stake-weighted value = claim × the stake factor captured when the claim was accepted; it feeds Q<sub>i</sub> in the reward. “Finalize” is permissionless after the deadline.</p>`);
    }
    const other = d.buckets.filter((b) => !b.finalized && b.canFinalize && !mine.some((x) => x.b.buyer === b.buyer));
    if (other.length) parts.push(warnBox(`${other.length} other bucket${other.length === 1 ? '' : 's'} left to finalize — rewards wait for ${other.length === 1 ? 'it' : 'them'}`, other.map((b) => `${whoAddress(b.buyer)} <button type="button" class="btn btn-sm" data-action="finalize-for" data-arg="${esc(b.buyer)}">Finalize</button>`).join('<br>')));
    setBody('claims', parts.join(''));
  }

  // ───────────────────────────── SELLER: rewards ─────────────────────────────

  function renderRewards(n) {
    const e = viewEpoch();
    if (e === null) {
      epochUnavailable('rewards');
      return;
    }
    const es = S.epochs[String(e)];
    if (!es?.loaded) return;
    setMeta('rewards', `epoch ${esc(String(e))} · ${since(es.at, es)}`);
    if (!es.data) {
      setBody('rewards', errorBox(es.error, { retry: true }));
      return;
    }
    if (!nodeInfo(n) && S.nodes.loaded && !S.nodes.data) {
      setBody('rewards', errorBox(S.nodes.error, { title: 'This node’s identity is unknown (chain unreachable)', retry: true }));
      return;
    }
    const d = es.data;
    const myId = W(nodeInfo(n)?.identityId);
    const row = d.nodes.find((x) => W(x.identityId) === myId);
    if (!row) {
      setBody('rewards', emptyBox('No identity', 'This node has no on-chain identity yet, so it cannot earn epoch rewards.'));
      return;
    }
    const lambda = W(d.params.lambdaQif18);
    const cap = Number(d.params.rewardCapMultiple);
    const finalizedAny = W(d.sumR) > 0n;
    const past = d.pastDeadline ?? d.settled;
    const useProjected = !d.allFinalized || !finalizedAny;
    const v = useProjected ? { R: row.projected.R, Q: row.projected.Q, sumR: row.projected.sumR, sumQ: row.projected.sumQ, qif: row.projected.qif18, reward: row.projected.reward, capBinding: row.projected.capBinding } : { R: row.R, Q: row.Q, sumR: row.sumR, sumQ: row.sumQ, qif: row.qif18, reward: row.expectedReward, capBinding: row.capBinding };
    const hasValue = useProjected ? W(row.projected.R) > 0n : W(row.R) > 0n;
    const checks = [
      [past, past ? `settlement deadline passed (${esc(fmtTime(d.deadline))})` : `settlement deadline ${countdown(d.deadline, { future: 'in {}', past: 'passed {} ago' })}${ttHint()}`],
      [d.allFinalized, d.allFinalized ? 'every bucket of the epoch is finalized' : `${esc(String(d.openBuckets))} bucket${W(d.openBuckets) === 1n ? '' : 's'} still to finalize${past ? ' (Finalize in “Claims on-chain” or the Buyer tab)' : ' (possible after the deadline)'}`],
      [finalizedAny, finalizedAny ? 'the epoch has finalized receipt value' : 'no finalized receipt value in the epoch yet'],
      [hasValue, hasValue
        ? `this node has ${useProjected ? '' : 'finalized '}receipt value in epoch ${esc(String(e))} (R<sub>i</sub> > 0${useProjected ? ', projected' : ''})`
        : `this node has no ${useProjected ? '' : 'finalized '}receipt value in epoch ${esc(String(e))} (R<sub>i</sub> = 0) — it served no calls that settle here, so there is nothing to claim`],
      [!row.claimed, row.claimed ? 'already claimed' : 'not claimed yet'],
    ];
    const unit = pickUnit(d.pool, v.sumR, v.sumQ, v.R, v.Q, v.reward);
    const rTerm = W(v.sumR) > 0n ? ((E18 - lambda) * W(v.R)) / W(v.sumR) : 0n;
    const qTerm = W(v.sumQ) > 0n ? (lambda * W(v.Q)) / W(v.sumQ) : 0n;
    const claimR = S.results[`claim${n}`];
    const parts = [staleBanner(es, S.nodes)];
    parts.push(`<p class="lede">The epoch pool is split by the QIF blend of finalized receipt value (R) and stake-weighted QueryInferenceScore (Q): <strong>reward = min(pool · QIF, ${cap} · R<sub>i</sub>)</strong>, QIF = (1 − λ)·R<sub>i</sub>/ΣR + λ·Q<sub>i</sub>/ΣQ.${useProjected ? ' Values below are <strong>projected</strong> as if every open bucket were finalized now.' : ''} Amounts in ${unit === 'micro' ? 'µTRAC' : 'TRAC'}.</p>`);
    parts.push(`<div class="stats">
      <div class="stat"><div class="k">R<sub>i</sub> ${useProjected ? '(projected)' : 'finalized value'}</div><div class="v">${amt(v.R, { unit })}</div><div class="s">${pctOf(v.R, v.sumR, 2)} of ΣR ${amt(v.sumR, { unit })}</div></div>
      <div class="stat"><div class="k">Q<sub>i</sub> ${useProjected ? '(projected)' : 'stake-weighted'}</div><div class="v">${amt(v.Q, { unit })}</div><div class="s">${pctOf(v.Q, v.sumQ, 2)} of ΣQ ${amt(v.sumQ, { unit })}</div></div>
      <div class="stat"><div class="k">QIF${useProjected ? ' (projected)' : ''}</div><div class="v">${pct18(v.qif, 4)}</div><div class="s">λ = ${esc(decimal(lambda, 18))}</div></div>
      <div class="stat"><div class="k">Epoch pool</div><div class="v">${amt(d.pool, { unit })}</div><div class="s">distributed ${amt(d.distributed, { unit })}</div></div>
      <div class="stat"><div class="k">${useProjected ? 'Projected reward' : row.claimed ? 'Reward (claimed)' : 'Expected reward'}</div><div class="v">${amt(v.reward, { unit })}</div><div class="s">${v.capBinding ? `capped at ${cap} × R<sub>i</sub>` : 'pool · QIF (cap not binding)'}</div></div>
    </div>`);
    parts.push(`<div class="formula">QIF = (1 − ${esc(decimal(lambda, 18))}) × ${esc(pctOf(v.R, v.sumR, 4))} + ${esc(decimal(lambda, 18))} × ${esc(pctOf(v.Q, v.sumQ, 4))} = ${esc(pct18(rTerm, 4))} + ${esc(pct18(qTerm, 4))} = ${esc(pct18(v.qif, 4))}</div>`);
    if (!useProjected && W(row.qif18) !== W(row.qifMirror18)) {
      parts.push(`<p class="hint">Contract QIF ${pct18(row.qif18, 6)} vs console mirror ${pct18(row.qifMirror18, 6)} (fixed-point floor ordering).</p>`);
    }
    parts.push(`<div class="section-label">Claim gate</div><ul class="checklist">${checks.map(([ok, text]) => `<li class="${ok ? 'yes' : 'no'}"><span class="mark">${ok ? '✓' : '○'}</span><span>${text}</span></li>`).join('')}</ul>`);
    if (claimR && claimR.epoch === String(e)) {
      if (claimR.r.ok) {
        const paid = claimR.r.json?.rewardWei;
        const delta = claimR.after !== null ? claimR.after - claimR.before : null;
        const headline = paid !== undefined ? amt(paid, { unit }) : delta !== null ? amt(delta, { unit }) : null;
        parts.push(okBox(`Reward claimed${headline ? `: +${headline}` : ' (tx sent)'}`, `${delta !== null ? `Operational wallets ${amt(claimR.before, { unit: 'trac' })} → ${amt(claimR.after, { unit: 'trac' })} (+${amt(delta, { unit })})` : 'Wallet balance not re-read yet'} · tx <span class="hex">${esc(shortHex(claimR.r.json?.txHash, 10, 8))}</span>`));
      } else {
        parts.push(errorBox(claimR.r));
      }
    }
    let hint;
    if (row.claimable) hint = `Pays ${amt(row.expectedReward, { unit })} to this node’s operational wallet.`;
    else if (row.claimed) hint = 'This epoch’s reward is already claimed.';
    else if (!hasValue && past && d.allFinalized) hint = `Nothing to claim: this node served no calls that were finalized in epoch ${esc(String(e))}.`;
    else if (!past) hint = `Enabled once every gate above is green — first the settlement deadline.${ttHint()}`;
    else hint = 'Enabled once every gate above is green.';
    parts.push(`<div class="row mt-3">
      <button type="button" class="btn btn-primary" data-action="claim" aria-describedby="claim-hint" ${!row.claimable || S.busy[`claim${n}`] ? 'disabled' : ''}>${S.busy[`claim${n}`] ? '<span class="spin"></span>Claiming…' : 'Claim reward'}</button>
      <span class="hint" id="claim-hint">${hint}</span>
    </div>`);
    setBody('rewards', parts.join(''));
  }

  async function doClaim(n) {
    const e = viewEpoch();
    S.busy[`claim${n}`] = true;
    render();
    await refreshNodes(true);
    const before = W(nodeInfo(n)?.tracWei);
    const r = await api(nodePath(n, '/settle'), { method: 'POST', body: { action: 'claim', epoch: String(e) }, timeoutMs: 120_000 });
    await refreshNodes(true);
    const after = r.ok && nodeInfo(n) ? W(nodeInfo(n)?.tracWei) : null;
    S.busy[`claim${n}`] = false;
    S.results[`claim${n}`] = { r, epoch: String(e), before, after };
    if (r.ok) {
      const paid = r.json?.rewardWei ?? (after !== null ? (after - before).toString() : null);
      toast(`Reward claimed${paid !== null ? `: +${amt(paid, { unit: pickUnit(paid) })}` : ''}`);
    } else toast(`Claim failed: ${esc(explain(r).title)}`, 'error');
    await refreshAll({ full: true });
  }

  // ───────────────────────────── devnet controls ─────────────────────────────

  async function doWarp(kind) {
    S.busy.warp = kind;
    renderTimeTravel();
    const body = kind === 'deadline' ? { toDeadline: true, epoch: String(viewEpoch()) } : { seconds: 3600 };
    const r = await api('/chain/warp', { method: 'POST', body, timeoutMs: 60_000 });
    S.busy.warp = null;
    closeTimeTravel();
    if (r.ok) {
      const j = r.json;
      const epochs = String(j.epochBefore) === String(j.epochAfter) ? `Still epoch ${esc(String(j.epochAfter))}.` : `Epoch ${esc(String(j.epochBefore))} → ${esc(String(j.epochAfter))}.`;
      toast(j.alreadyPast ? 'Already past that deadline — no time travel needed.' : `Chain time advanced ${esc(fmtDur(Number(j.warpedSeconds)))} to ${esc(fmtClock(Number(j.chainTimeAfter)))} (devnet). ${epochs} Nodes notice within ~30 s.`, 'warn');
      // Show the new time at once (the full refresh below replaces this).
      if (S.chain.data && W(j.chainTimeAfter) > 0n) {
        S.chain.data = { ...S.chain.data, chainTime: String(j.chainTimeAfter) };
        S.chain.at = Date.now();
        tickClocks();
      }
    } else {
      toast(`Time travel failed: ${esc(explain(r).body)}`, 'error');
    }
    await refreshAll({ full: true });
  }

  async function doTopUp() {
    S.busy.topup = true;
    render();
    const r = await api('/chain/fund-buyer', { method: 'POST', body: { node: 2, trac: '100' } });
    S.busy.topup = false;
    if (r.ok) toast(`Buyer wallet topped up: ${amt(r.json.beforeWei, { unit: 'trac' })} → ${amt(r.json.afterWei, { unit: 'trac' })}`);
    else toast(`Top-up failed: ${esc(explain(r).body)}`, 'error');
    await refreshNodes(true);
    render();
  }

  // ───────────────────────────── events ─────────────────────────────

  function setView(view, { focus = false } = {}) {
    if (!VIEWS[view]) view = 'buyer';
    S.view = view;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    mountView();
    if (focus) $(`#tab-${view}`)?.focus();
    refreshAll({ full: true });
  }

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    for (const b of $$('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === (choice || 'auto')));
  }

  function toggleReveal(el) {
    const k = el.dataset.wei;
    if (S.revealed.has(k)) S.revealed.delete(k);
    else S.revealed.add(k);
    for (const a of $$(`.amt[data-wei="${CSS.escape(k)}"]`)) a.classList.toggle('is-revealed', S.revealed.has(k));
  }

  document.addEventListener('click', (ev) => {
    const amtEl = ev.target.closest('.amt');
    if (amtEl) {
      toggleReveal(amtEl);
      return;
    }
    const tab = ev.target.closest('[role="tab"]');
    if (tab) {
      setView(tab.dataset.view);
      return;
    }
    const theme = ev.target.closest('[data-theme-choice]');
    if (theme) {
      const c = theme.dataset.themeChoice;
      store.set('mkt-console-theme', c);
      applyTheme(c);
      return;
    }
    const svcBtn = ev.target.closest('[data-pg-svc]');
    if (svcBtn) {
      const ta = $('#pg-input');
      if (ta) {
        if (S.pg.service === 'query') S.pg.sparql = ta.value;
        else S.pg.prompt = ta.value;
      }
      S.pg.service = svcBtn.dataset.pgSvc;
      mountPlayground();
      return;
    }
    const act = ev.target.closest('[data-action]');
    if (!act || act.disabled) return;
    const a = act.dataset.action;
    const n = VIEWS[S.view].node;
    switch (a) {
      case 'retry':
        refreshAll({ full: true });
        break;
      case 'epoch-auto':
        S.viewEpochPinned = false;
        S.viewEpoch = null;
        refreshAll({ full: true });
        break;
      case 'open-timetravel':
        openTimeTravel();
        break;
      case 'tt-cancel':
        closeTimeTravel();
        break;
      case 'tt-deadline':
        doWarp('deadline');
        break;
      case 'tt-hour':
        doWarp('hour');
        break;
      case 'strip-toggle':
        S.stripOpen = !S.stripOpen;
        renderStrip();
        break;
      case 'topup':
        doTopUp();
        break;
      case 'sub-add':
        S.sub.buckets.push({ serviceType: 'inference', modelId: '', budgetTrac: '0.001', capMicro: '1', maxUnits: '1000' });
        mountSubscribe();
        break;
      case 'sub-rm':
        S.sub.buckets.splice(Number(act.dataset.arg), 1);
        mountSubscribe();
        break;
      case 'subscribe':
        doSubscribe();
        break;
      case 'invoke':
        doInvoke();
        break;
      case 'probe-ceiling':
        probeCeiling();
        break;
      case 'finalize':
        doFinalize(undefined, 2);
        break;
      case 'finalize-for':
        doFinalize(act.dataset.arg, n);
        break;
      case 'of-add':
        S.editors[n].rows.push({ id: '', serviceType: 'inference', unit: 'token', modelId: '', askMicro: '1' });
        S.editors[n].dirty = true;
        mountOfferings(n);
        $(`#of-id-${S.editors[n].rows.length - 1}`)?.focus();
        break;
      case 'of-rm':
        S.editors[n].rows.splice(Number(act.dataset.arg), 1);
        S.editors[n].dirty = true;
        mountOfferings(n);
        break;
      case 'of-defaults':
        S.editors[n].rows = DEVNET_OFFERINGS[n].map((r) => ({ ...r }));
        S.editors[n].dirty = true;
        mountOfferings(n);
        break;
      case 'of-reload':
        initEditor(n, { force: true });
        S.editors[n].initialized = true;
        mountOfferings(n);
        break;
      case 'publish':
        doPublish(n);
        break;
      case 'flush':
        doFlush(n);
        break;
      case 'claim':
        doClaim(n);
        break;
      default:
        break;
    }
  });

  document.addEventListener('keydown', (ev) => {
    const amtEl = ev.target.closest?.('.amt');
    if (amtEl && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      toggleReveal(amtEl);
      return;
    }
    const tab = ev.target.closest?.('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      const tabs = $$('[role="tab"]');
      const i = tabs.indexOf(tab);
      const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setView(tabs[next].dataset.view, { focus: true });
    }
    if (ev.key === 'Enter' && ev.target.id === 'pg-input' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      doInvoke();
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset?.sub) {
      const k = t.dataset.sub;
      if (k === 'showWei') {
        S.sub.showWei = t.checked;
        $('#sub-form')?.classList.toggle('show-wei-form', t.checked);
        return;
      }
      if (t.dataset.i !== undefined) S.sub.buckets[Number(t.dataset.i)][k] = t.value;
      else S.sub[k] = t.value;
      updateSubPreviews();
      renderSubscribeLive();
      if (S.view === 'buyer') {
        renderOffers();
        renderPlaygroundLive();
      }
      return;
    }
    if (t.dataset?.deny !== undefined) {
      if (t.checked) S.sub.deny.add(t.dataset.deny);
      else S.sub.deny.delete(t.dataset.deny);
      renderOffers();
      renderPlaygroundLive();
      return;
    }
    if (t.dataset?.of) {
      const n = VIEWS[S.view].node;
      S.editors[n].rows[Number(t.dataset.i)][t.dataset.of] = t.value;
      S.editors[n].dirty = true;
      updateOfferingPreviews(n);
      renderOfferingsLive(n);
      return;
    }
    if (t.id === 'pg-input') {
      if (S.pg.service === 'query') S.pg.sparql = t.value;
      else S.pg.prompt = t.value;
      renderPlaygroundLive();
      return;
    }
    if (t.id === 'pg-units') {
      S.pg.maxUnits[S.pg.service] = t.value;
      renderPlaygroundLive();
      return;
    }
    if (t.id === 'toggle-wei') {
      document.body.classList.toggle('show-wei', t.checked);
      store.set('mkt-console-wei', t.checked ? '1' : '0');
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'epoch-select') {
      S.viewEpoch = W(t.value);
      S.viewEpochPinned = true;
      refreshAll({ full: true });
    }
    if (t.dataset?.sub === 'epochChoice' || t.dataset?.sub === 'serviceType') {
      if (t.dataset.i !== undefined) S.sub.buckets[Number(t.dataset.i)][t.dataset.sub] = t.value;
      else S.sub[t.dataset.sub] = t.value;
      renderSubscribeLive();
      renderOffers();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll();
  });
  // A reload/close mid-call aborts the fetch; don't record that as a failure.
  window.addEventListener('pagehide', () => {
    S.unloading = true;
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (VIEWS[v] && v !== S.view) setView(v);
  });

  // ───────────────────────────── boot ─────────────────────────────

  function boot() {
    applyTheme(store.get('mkt-console-theme') ?? 'auto');
    const wei = store.get('mkt-console-wei') === '1';
    document.body.classList.toggle('show-wei', wei);
    const tw = $('#toggle-wei');
    if (tw) tw.checked = wei;
    const hist = session.get(HISTORY_KEY);
    if (Array.isArray(hist)) {
      // Entries still "pending" were cut off by a reload/close: their outcome
      // is unknown (the node may have served and charged them).
      S.history = hist.slice(0, 50).map((x) => {
        const state = x.state ?? (x.ok ? 'ok' : x.code === 'HTTP 0' ? 'unknown' : 'failed');
        return state === 'pending' ? { ...x, state: 'unknown', title: 'the page was reloaded before the node answered' } : { ...x, state };
      });
      saveHistory();
    }
    const observed = session.get('mkt-console-observed');
    if (observed && typeof observed === 'object') S.observed = observed;
    const v = location.hash.slice(1);
    S.view = VIEWS[v] ? v : 'buyer';
    mountView();
    refreshAll({ full: true });
    setInterval(() => {
      if (!document.hidden) refreshAll();
    }, REFRESH_MS);
    setInterval(tickClocks, 1000);
  }

  // The subscribe form needs the remembered plan before its first mount.
  (async () => {
    await refreshConsoleState();
    boot();
  })();
})();
