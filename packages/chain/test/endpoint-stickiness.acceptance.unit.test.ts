// SPDX-License-Identifier: Apache-2.0
/**
 * Endpoint-stickiness (Mechanism B, #1340 retry residual + #1337 fail-close)
 * ACCEPTANCE suite (AC-1..AC-29). Split out of `rpc-failover-client.unit.test.ts`
 * — that file's load-bearing focus is the WRITE transport + `resolveCapMs` matrix;
 * this file owns the stickiness state-machine acceptance criteria.
 *
 * Prefer the last-good backend after a failover; re-probe the configured primary
 * at most once per TTL; stay fully transparent on `skipPreferred` tip reads; clear
 * on a primary success. The kill-switch (`enabled:false`) reproduces the
 * pre-Mechanism-B index-0 behavior — the RED baseline these assertions are written
 * against (AC-4 pins that equivalence). Deterministic: injected `now` (no fake
 * timers) + bare recorder doubles, so we assert TRY-ORDER via call counts, not
 * wall-clock. The shared transport-double helpers (`recorder`, `makeClient`,
 * `retryable429`, `NEVER_SIGN`) come from `./rpc-failover-test-helpers.js`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { RpcFailoverClient, type SignPopulatedFn } from '../src/rpc-failover-client.js';
import { _resetRpcFailoverStatsForTest, getRpcFailoverStats } from '../src/rpc-failover-log.js';
import { recorder, retryable429, NEVER_SIGN, makeClient } from './rpc-failover-test-helpers.js';

afterEach(() => { _resetRpcFailoverStatsForTest(); });

describe('RpcFailoverClient — endpoint stickiness (Mechanism B)', () => {
  const STICKY_URLS = ['https://primary.example', 'https://backup.example'];

  // A read double: for call N, `fn(N)` returns a value to resolve, or an Error to throw.
  const readSeq = (fn: (n: number) => unknown) => {
    let n = 0;
    return recorder(async () => {
      n += 1;
      const out = fn(n);
      if (out instanceof Error) throw out;
      return out;
    });
  };

  it('AC-1: after a failover the NEXT read tries the last-good backend FIRST (primary not re-probed)', async () => {
    const primary = { read: readSeq(() => retryable429()) }; // always 429
    const backup = { read: readSeq(() => 'BACKUP') };        // always ok
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1: fail over → establish preferred=backup
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op2: backup FIRST
    expect(primary.read.calls).toHaveLength(1); // NOT re-probed (index-0 would make this 2)
    expect(backup.read.calls).toHaveLength(2);
  });

  it('AC-4: kill-switch (enabled:false) reproduces index-0 — op2 re-probes the primary every call', async () => {
    const primary = { read: readSeq(() => retryable429()) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: false });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // index-0: primary re-probed on BOTH ops (the pre-change baseline)
    expect(backup.read.calls).toHaveLength(2);
  });

  it('AC-2: a write that fails over primes the preferred → the following receipt lookup targets that backend', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    const primary = {
      broadcastTransaction: recorder(async () => { throw retryable429(); }), // primary 429s
      getTransactionReceipt: recorder(async () => receipt),                   // primary WOULD answer...
    };
    const backup = {
      broadcastTransaction: recorder(async () => undefined),                  // backup broadcasts ok
      getTransactionReceipt: recorder(async () => receipt),                   // ...but backup is preferred first
    };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    await client.broadcast('0xsigned', '0xhash', 'w'); // primary 429 → backup ok → preferred := backup
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);

    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);  // receipt looked up on the backup FIRST
    expect(primary.getTransactionReceipt.calls).toHaveLength(0); // primary not polled — read-your-write on ONE backend
  });

  it('AC-3: under a persistently degraded primary, the primary is re-probed at most ONCE per TTL (not every call)', async () => {
    let clock = 0;
    const primary = { read: readSeq(() => retryable429()) }; // stays down the whole test
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;      await client.read('r', (p: any) => p.read()); // op1: establish, arm due=30_000
    clock = 10_000; await client.read('r', (p: any) => p.read()); // within TTL → backup first
    clock = 20_000; await client.read('r', (p: any) => p.read()); // within TTL → backup first
    expect(primary.read.calls).toHaveLength(1); // only the op1 establish probe so far

    clock = 35_000; await client.read('r', (p: any) => p.read()); // past TTL → RE-PROBE primary, re-arm due=65_000
    expect(primary.read.calls).toHaveLength(2); // exactly one re-probe

    clock = 40_000; await client.read('r', (p: any) => p.read()); // within the new window → backup first
    clock = 50_000; await client.read('r', (p: any) => p.read()); // within the new window → backup first
    expect(primary.read.calls).toHaveLength(2); // STILL 2 — NOT re-probed every call (Finding-1 regression guard)

    clock = 66_000; await client.read('r', (p: any) => p.read()); // past the 2nd window → re-probe again
    expect(primary.read.calls).toHaveLength(3);
  });

  it('AC-3b: a primary re-probe that SUCCEEDS clears the preference (primary resumes)', async () => {
    let clock = 0;
    // primary: 429 on call 1 (establish), healthy from call 2 (the re-probe onward)
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;      expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');  // establish preferred=backup
    clock = 35_000; expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY'); // re-probe → primary ok → CLEAR
    clock = 36_000; expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY'); // preference cleared → canonical
    expect(primary.read.calls).toHaveLength(3); // op1 429 + re-probe + canonical-after-clear
    expect(backup.read.calls).toHaveLength(1);  // only the initial failover
  });

  it('AC-5: a single-RPC client never establishes a preferred (nothing to fail over to)', async () => {
    const only = { read: readSeq(() => 'ONLY') };
    const client = makeClient([only], ['https://only.example'], NEVER_SIGN, { enabled: true });

    await client.read('r', (p: any) => p.read());
    await client.read('r', (p: any) => p.read());
    expect(only.read.calls).toHaveLength(2);
    expect(getRpcFailoverStats().preferredEstablishments).toBe(0); // lone endpoint == primary → never sticks
  });

  it('AC-7: a skipPreferred read uses canonical order AND leaves the preference intact (transparent)', async () => {
    // primary: 429 on call 1 (establish backup), healthy afterwards
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1: establish preferred=backup

    // op2 skipPreferred → canonical (primary first) AND must NOT clear the preference
    expect(await client.read('r', (p: any) => p.read(), { skipPreferred: true })).toBe('PRIMARY');

    // op3 (normal) → preference SURVIVED op2 → backup first
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // op1 (429) + op2 (skipPreferred canonical). If op2 had CLEARED, op3 → 3.
    expect(backup.read.calls).toHaveLength(2);  // op1 + op3
  });

  it('AC-6: with a primed preferred, the reorder DOES happen yet the exhaustion error still reports rpcUrls in CANONICAL order', async () => {
    // A shared try-order log proves the reorder actually occurred (so the
    // canonical-rpcUrls assertion isn't vacuously true against a no-op reorder).
    const order: string[] = [];
    const primary = { read: recorder(async () => { order.push('primary'); throw retryable429(); }) };
    let backupN = 0;
    const backup = { read: recorder(async () => { order.push('backup'); backupN += 1; if (backupN === 1) return 'BACKUP'; throw retryable429(); }) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1 canonical: primary 429 → backup ok → preferred=backup
    expect(order).toEqual(['primary', 'backup']);

    order.length = 0;
    let thrown: any;
    try { await client.read('r', (p: any) => p.read()); } catch (e) { thrown = e; }
    expect(order).toEqual(['backup', 'primary']); // op2 REORDERED: backup tried FIRST (the reorder genuinely happened)
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(thrown.rpcUrls).toEqual(STICKY_URLS); // ...yet rpcUrls stays CANONICAL [primary, backup], not [backup, primary]
  });

  it('AC-9: a preferred backup that RESPONDS (getReceipt null, no failure) while the primary serves the fallback KEEPS the preference (cadence fix; distinct from a FAILED backup — AC-22)', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    // Establish preferred=backup via a read failover.
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')), getTransactionReceipt: recorder(async () => receipt) };
    const backup = { read: readSeq(() => 'BACKUP'), getTransactionReceipt: recorder(async () => null) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // establish preferred=backup

    // getReceipt: [backup, primary]. The backup RESPONDS with null (not-yet-mined) —
    // NOT a failure — so the loop continues to the primary, which has the receipt.
    // Because the backup did not FAIL, the preference must NOT be cleared (a benign
    // "no data here" fallback is not evidence the backup is degraded).
    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);

    // Preference SURVIVED → the next read still prefers the backup.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(1); // only op1's establish 429 — the primary is NOT re-probed for reads
  });

  it('AC-22: a preferred backup that FAILS (errors) is DE-PREFERRED (not re-tried first every op, which would re-fail-close) (round-7 🔴)', async () => {
    // primary: 429 on the op1 establish probe, healthy afterward.
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    // backup: ok on op1 (establish), then FAILS (429) from op2 on — a hanging/erroring backup.
    const backup = { read: readSeq((n) => (n === 1 ? 'BACKUP' : retryable429())) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1: establish preferred=backup

    // op2 [backup, primary]: backup FAILS (429) → recordFailure de-prefers it → primary serves.
    expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY');

    // op3: backup was de-preferred → canonical [primary, backup] → primary tried FIRST
    // (NOT re-stalled on the failed backup, which is the #1337 fail-close this prevents).
    expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY');
    expect(backup.read.calls).toHaveLength(2); // op1 (ok) + op2 (429). NOT op3 — de-preferred. (Bug: 3.)
    expect(primary.read.calls).toHaveLength(3);
  });

  it('AC-23: past the TTL a nonce-critical populate STAYS on the write-proven backend (does NOT re-probe a possibly-stale primary) (round-7 🔴)', async () => {
    let clock = 0;
    const p0 = {}; const p1 = {};
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // establish write-proven backup
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Past the TTL: a READ re-probe would go canonical, but a nonce-critical populate
    // MUST NOT (stale-nonce risk on a just-recovered-but-lagging primary) — it keeps
    // the write-proven backend.
    clock = 40_000;
    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    expect(populateOrder).toEqual(['backup']); // backup tried FIRST — no primary re-probe. (Bug: ['primary','backup'].)
  });

  it('AC-24: a populate on a READ-established preferred backend UPGRADES it to write-proven, so the next populate sticks (round-7 🟡 coverage)', async () => {
    const p0 = { read: readSeq(() => retryable429()) };
    const p1 = { read: readSeq(() => 'BACKUP') };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // primary populate 429s, backup populate ok (so a populate proves the backup).
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // establish preferred=backup, source=READ

    // populate #1: source=read → nonceWrite won't trust a read-only backend's nonce →
    // canonical → primary 429 → backup populates → UPGRADES the preference read→write.
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    expect(populateOrder).toEqual(['primary', 'backup']);

    // populate #2: now write-proven → sticks to the backup first (proves the upgrade).
    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    expect(populateOrder).toEqual(['backup']);
  });

  it('AC-25: a benign-null getReceipt on a write-proven backend (primary serves) DOWNGRADES source write→read → the next populate goes canonical (round-8 🔴 — exercises the downgrade branch, which recordFailure does NOT)', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    const p0: any = { getTransactionReceipt: recorder(async () => receipt) }; // primary HAS the receipt
    const p1: any = { getTransactionReceipt: recorder(async () => null) };    // write-proven backup: benign null (lagging, NOT a failure)
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    let primaryPopN = 0;
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => {
      const which = s.boundTo === p0 ? 'primary' : 'backup';
      populateOrder.push(which);
      if (which === 'primary') { primaryPopN += 1; if (primaryPopN === 1) return Promise.reject(retryable429()); }
      return Promise.resolve({ to: '0xTO', data: '0x' });
    } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // establish WRITE-proven backup (primary 429 → backup)
    expect(populateOrder).toEqual(['primary', 'backup']);

    // getReceipt: the write-proven backup returns null (benign — NOT a failure, so
    // recordFailure does NOT fire), the primary serves the receipt as a write
    // fallback → the backend's nonce view is suspect → DOWNGRADE source write→read.
    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(p1.getTransactionReceipt.calls).toHaveLength(1); // backup tried first (null)
    expect(p0.getTransactionReceipt.calls).toHaveLength(1); // primary served

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    // Downgraded → nonceWrite re-derives from CANONICAL (primary first). Without the
    // downgrade branch this would be ['backup'] (still write-proven).
    expect(populateOrder).toEqual(['primary']);
  });

  it('AC-26: a skipPreferred read that FAILS OVER (primary → backup) does NOT establish a preference — transparent stays non-mutating even on the fallback path (round-8 🟡)', async () => {
    const order: string[] = [];
    const primary = { read: recorder(async () => { order.push('primary'); throw retryable429(); }) };
    const backup = { read: recorder(async () => { order.push('backup'); return 'BACKUP'; }) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    // Transparent read from a CLEAN state that fails over primary→backup must NOT
    // establish a sticky preference (else background tip/poller reads would silently
    // make a backup preferred despite the preference-transparent contract).
    expect(await client.read('r', (p: any) => p.read(), { skipPreferred: true })).toBe('BACKUP');
    expect(getRpcFailoverStats().preferredEstablishments).toBe(0); // transparent success did NOT establish

    // The next NORMAL read is canonical (primary FIRST) — proving no preference leaked.
    order.length = 0;
    await client.read('r', (p: any) => p.read()).catch(() => {}); // canonical: primary 429 → backup
    expect(order[0]).toBe('primary');
  });

  it('AC-27: a benign EMPTY result (isEmptyResult) fails over but does NOT de-prefer the endpoint or inflate telemetry (round-9/10 🔴)', async () => {
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    // backup: ok on op1 (establish), a benign null on op2, ok on op3.
    const backup = { read: readSeq((n) => (n === 2 ? null : 'BACKUP')) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // establish preferred=backup
    const before = getRpcFailoverStats();

    // op2: the preferred backup returns a BENIGN null → fails over to the primary,
    // but a null is NOT a failure: the backup is NOT de-preferred, and no
    // failover/exhaustion telemetry is emitted.
    expect(await client.read('r', (p: any) => p.read(), { isEmptyResult: (v) => v == null })).toBe('PRIMARY');
    const after = getRpcFailoverStats();
    expect(after.failovers).toBe(before.failovers);       // a benign empty is NOT a failover
    expect(after.exhaustions).toBe(before.exhaustions);   // ...nor an exhaustion

    // op3: the preference SURVIVED the benign null → backup tried FIRST again.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // op1 (429) + op2 (fallback). NOT op3 — backup was NOT de-preferred.
    expect(backup.read.calls).toHaveLength(3);  // op1 + op2 (null) + op3
  });

  it('AC-28: an already-known broadcast (idempotent success) ESTABLISHES the preference like a normal broadcast (round-9/10 🟡)', async () => {
    const knownTxError = () => new Error('already known');
    const primary = { broadcastTransaction: recorder(async () => { throw retryable429(); }), read: recorder(async () => 'PRIMARY') };
    const backup = { broadcastTransaction: recorder(async () => { throw knownTxError(); }), read: recorder(async () => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    // primary 429 → backup returns "already known" (idempotent success) → the backup
    // is where the tx is known → it establishes the preference, same as a real send.
    await client.broadcast('0xsigned', '0xhash', 'w');
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // prefers the established backend
    expect(primary.read.calls).toHaveLength(0);
  });

  it('AC-29: past the TTL, a WRITE (broadcast) stays on the write-proven backend — NOT re-probed to the primary (which could reject the backup-signed nonce terminally) (round-11 🔴)', async () => {
    let clock = 0;
    const p0: any = {}; const p1: any = {};
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // populate: primary 429s, backup ok → write-proven backup.
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    // broadcast: primary throws a NON-RETRYABLE nonce error (would terminate the loop if tried first); backup ok.
    const nonceTooHigh = () => { const e: any = new Error('nonce too high'); e.code = 'CALL_EXCEPTION'; return e; };
    p0.broadcastTransaction = recorder(async () => { throw nonceTooHigh(); });
    p1.broadcastTransaction = recorder(async () => undefined);
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // establish write-proven backup
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Past the TTL, broadcast the backup-signed tx. It must try the BACKUP first
    // (where the tx was signed / nonce is consistent), NOT re-probe the primary
    // (which is behind and rejects the nonce with a NON-retryable error the broadcast
    // loop would treat as terminal, never reaching the backup).
    clock = 40_000;
    await client.broadcast('0xS', '0xH', 'w');
    expect(p1.broadcastTransaction.calls).toHaveLength(1); // backup FIRST, succeeded
    expect(p0.broadcastTransaction.calls).toHaveLength(0); // primary NOT re-probed. (Bug: primary throws terminally.)
  });

  it('AC-10: a populateAndSign failover primes the preferred for the following read (the 4th loop establishes too)', async () => {
    const p0 = { read: recorder(async () => { throw retryable429(); }) };
    const p1 = { read: recorder(async () => 'BACKUP-READ') };
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const makeSigner = () => ({ address: '0x' + 'ab'.repeat(20), connect: (p: unknown) => ({ address: '0x' + 'ab'.repeat(20), boundTo: p }) }) as any;
    // populateTransaction 429s when the signer is bound to p0 (primary), succeeds on p1 (backup).
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => (s.boundTo === p0 ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' })) } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await expect(client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'))
      .resolves.toEqual({ signedTx: '0xS', txHash: '0xH' }); // primary populate 429 → backup populates+signs → preferred=backup
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);

    // The subsequent read prefers the backup the write signed on → primary read NOT probed.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP-READ');
    expect(p0.read.calls).toHaveLength(0);
    expect(p1.read.calls).toHaveLength(1);
  });

  it('AC-11: a null (not-yet-mined) receipt does NOT establish a preference', async () => {
    const primary = { getTransactionReceipt: recorder(async () => { throw retryable429(); }) };
    const backup = { getTransactionReceipt: recorder(async () => null) }; // responds, but no receipt yet
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    await expect(client.getReceipt('0xhash')).resolves.toBeNull();
    // A null tick has no single winning endpoint (both were visited; neither had
    // the receipt), so notePreferredOutcome must not fire → no preference established.
    // (A regression hoisting the note above the `if (receipt)` null-check would
    // establish a preference on whichever backend merely answered "not mined yet".)
    expect(getRpcFailoverStats().preferredEstablishments).toBe(0);
  });

  it('AC-12: if a live pool rebind drops the preferred endpoint, ordering falls back to canonical cleanly (idx<0)', async () => {
    let urls = [...STICKY_URLS];
    let providers: any[] = [{ read: readSeq(() => retryable429()) }, { read: readSeq(() => 'BACKUP') }];
    const client = new RpcFailoverClient(
      () => providers.map((p, i) => ({ provider: p as any, rpcUrl: urls[i] })),
      NEVER_SIGN,
      () => 'evm:31337',
      { stickiness: { enabled: true } },
    );
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // establish preferred = backup.example

    // Live pool rebind: a completely different endpoint set (the preferred url is gone).
    urls = ['https://new-primary.example', 'https://new-backup.example'];
    const np = recorder(async () => 'NEW-PRIMARY');
    const nb = recorder(async () => 'NEW-BACKUP');
    providers = [{ read: np }, { read: nb }];

    // preferred no longer present in canonical (idx<0) → clean fall-back to canonical → new-primary first.
    expect(await client.read('r', (p: any) => p.read())).toBe('NEW-PRIMARY');
    expect(np.calls).toHaveLength(1);
    expect(nb.calls).toHaveLength(0);
  });

  it('AC-8: establishing a preferred emits a host-only stickiness log + increments the counter', async () => {
    const primary = { read: readSeq(() => retryable429()) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...a: unknown[]) => { warns.push(String(a[0])); }) as typeof console.warn;
    try {
      await client.read('r', (p: any) => p.read());
    } finally {
      console.warn = origWarn;
    }
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);
    expect(warns.some((w) => w.includes('stickiness') && w.includes('backup.example'))).toBe(true);
    expect(warns.every((w) => !w.includes('https://'))).toBe(true); // host-only — never a full URL
  });

  // --- nonce-staleness guard: a read-established preference must not steer a
  // nonce-critical populate to a possibly-lagging backend (otReviewAgent 🔴).
  const SIGNER_ADDR = '0x' + 'ab'.repeat(20);
  const makeSigner = () => ({ address: SIGNER_ADDR, connect: (p: unknown) => ({ address: SIGNER_ADDR, boundTo: p }) }) as any;

  it('AC-13: a READ-established preference does NOT steer a write populate (populate stays canonical/primary-first)', async () => {
    const p0 = { read: readSeq(() => retryable429()) };  // primary read 429s → establishes backup as READ preferred
    const p1 = { read: readSeq(() => 'BACKUP') };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // Both endpoints can populate; record which the signer was bound to.
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { populateOrder.push(s.boundTo === p0 ? 'primary' : 'backup'); return Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    expect(await client.read('r', (pr: any) => pr.read())).toBe('BACKUP'); // READ establishes preferred=backup (NOT populate-proven)

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    // The nonce-critical populate STARTED on the canonical primary (the authoritative
    // nonce source), NOT the read-preferred backup — so a lagging read-preferred
    // backend can never sign a stale nonce.
    expect(populateOrder).toEqual(['primary']);
  });

  it('AC-14: once a populate PROVES a backend (primary down for writes), subsequent writes stick to it (#1340, no per-write primary re-probe)', async () => {
    const p0 = {}; const p1 = {};
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // primary populate always 429s (down for writes); backup populates ok.
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const which = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(which); return which === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write #1: canonical → primary 429 → backup → populate-proven
    expect(populateOrder).toEqual(['primary', 'backup']);

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write #2: populate-proven backend tried FIRST
    expect(populateOrder).toEqual(['backup']); // primary NOT re-probed — write stickiness preserved for #1340
  });

  it('AC-15: a write-proven backend that FAILS a later broadcast (primary takes over as fallback) is downgraded → the next populate re-derives from canonical (#A)', async () => {
    // primary broadcast OK, backup broadcast FAILS (so the tx moves to the primary
    // as a fallback); primary populate 429s, backup populate OK (so populate proves backup).
    const p0 = { broadcastTransaction: recorder(async () => undefined) };
    const p1 = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // populate proves backup (source=write)
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Broadcast tx: preferred=backup → backup FAILS → primary broadcasts as a FALLBACK.
    await client.broadcast('0xsigned', '0xhash', 'w');
    expect(p1.broadcastTransaction.calls).toHaveLength(1); // backup tried first, failed
    expect(p0.broadcastTransaction.calls).toHaveLength(1); // primary took over

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // next populate
    // The backup's nonce view is now suspect (it failed the write; the tx moved to
    // the primary), so the write-preference was downgraded → populate re-derives
    // from canonical (primary-first). Without the #A downgrade this would be ['backup'].
    expect(populateOrder).toEqual(['primary', 'backup']);
  });

  it('AC-16: a write-proven backend SURVIVES an intervening read on it — the next populate still sticks to it (#B)', async () => {
    const p0 = {};
    const p1 = { read: recorder(async () => 'BACKUP-READ') };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // populate proves backup (source=write)
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Intervening READ served by the same preferred backend — must NOT downgrade the write-proven flag.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP-READ');

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // still write-proven → sticks to backup
    expect(populateOrder).toEqual(['backup']); // the read did NOT reset the write-proven source
  });

  it('AC-17: a re-point after a live pool rebind (expired carried-over deadline) arms a FRESH TTL — no per-op primary re-probe (round-4 🔴)', async () => {
    let clock = 0;
    let urls = ['https://p.example', 'https://b.example'];
    let providers: any[] = [{ read: readSeq(() => retryable429()) }, { read: readSeq(() => 'B') }];
    const client = new RpcFailoverClient(
      () => providers.map((p, i) => ({ provider: p as any, rpcUrl: urls[i] })),
      NEVER_SIGN,
      () => 'evm:31337',
      { stickiness: { enabled: true, ttlMs: 30_000, now: () => clock } },
    );
    clock = 0;
    expect(await client.read('r', (p: any) => p.read())).toBe('B'); // establish B, due = 30_000

    // Live pool rebind PAST the TTL: B is gone, new pool [C(primary, down), D].
    clock = 60_000;
    urls = ['https://c.example', 'https://d.example'];
    const cRead = readSeq(() => retryable429());
    const dRead = recorder(async () => 'D');
    providers = [{ read: cRead }, { read: dRead }];
    expect(await client.read('r', (p: any) => p.read())).toBe('D'); // preferred B absent → canonical → C fails → D → re-point + FRESH due
    expect(cRead.calls).toHaveLength(1); // C probed once (the rebind op)

    clock = 60_001;
    expect(await client.read('r', (p: any) => p.read())).toBe('D'); // within the FRESH window → D preferred first
    expect(cRead.calls).toHaveLength(1); // primary NOT re-probed (bug: a stale deadline would re-probe every op → 2)
    expect(dRead.calls).toHaveLength(2);
  });

  it('AC-19: getReceipt is a first-class ESTABLISHER — a non-null receipt after failover primes the preference (round-4 🟡)', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    const primary = { getTransactionReceipt: recorder(async () => { throw retryable429(); }), read: recorder(async () => 'P') };
    const backup = { getTransactionReceipt: recorder(async () => receipt), read: recorder(async () => 'B') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    // getReceipt runs as the FIRST loop: primary 429 → backup returns the receipt →
    // it (not a prior broadcast) establishes the preferred endpoint.
    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);

    // A following read prefers the backend getReceipt established.
    expect(await client.read('r', (p: any) => p.read())).toBe('B');
    expect(primary.read.calls).toHaveLength(0); // primary NOT tried — the receipt establishment carried over
  });

  it('AC-18: multi-backup re-point (preferred backup degrades mid-window → next backup) keeps the cadence (round-4 🟡)', async () => {
    let clock = 0;
    const pRead = readSeq(() => retryable429());     // primary always down
    let bN = 0;
    const bRead = recorder(async () => { bN += 1; if (bN >= 2) throw retryable429(); return 'B'; }); // ok once, then degrades
    const cRead = recorder(async () => 'C');
    const client = makeClient(
      [{ read: pRead }, { read: bRead }, { read: cRead }],
      ['https://p.example', 'https://b.example', 'https://c.example'],
      NEVER_SIGN,
      { enabled: true, ttlMs: 30_000, now: () => clock },
    );
    clock = 0;
    expect(await client.read('r', (p: any) => p.read())).toBe('B'); // establish B
    clock = 10_000;
    expect(await client.read('r', (p: any) => p.read())).toBe('C'); // preferred B degrades → fail over B→P→C → re-point to C (in-window)
    clock = 11_000;
    const pBefore = pRead.calls.length;
    expect(await client.read('r', (p: any) => p.read())).toBe('C'); // preferred C tried first
    expect(pRead.calls.length).toBe(pBefore); // primary NOT re-probed (still within the original TTL window)
  });

  it('AC-20: readContract honors skipPreferred (transparent) — the REAL contract-read path the event-lane scan relies on (round-5 🔴)', async () => {
    // Proves skipPreferred survives into RpcFailoverClient.readContract (not just
    // the adapter opts plumbing): `queryFilterWithFailover` passes it here, so if
    // readContract dropped `opts.skipPreferred` event scans would silently go sticky.
    const p0 = {}; const p1 = {};
    let n0 = 0;
    const primaryView = recorder(async () => { n0 += 1; if (n0 === 1) throw retryable429(); return 'PRIMARY'; });
    const backupView = recorder(async () => 'BACKUP');
    const contract = { connect: (p: unknown) => (p === p0 ? { view: primaryView } : { view: backupView }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.readContract('v', contract, (c: any) => c.view())).toBe('BACKUP'); // op1: primary 429 → backup → preferred=backup

    // op2 with skipPreferred → CANONICAL (primary tried first). If readContract
    // ignored the flag it would prefer the backup and return 'BACKUP'.
    expect(await client.readContract('v', contract, (c: any) => c.view(), { skipPreferred: true })).toBe('PRIMARY');
  });
});
