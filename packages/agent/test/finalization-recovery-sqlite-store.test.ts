import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import {
  FINALIZATION_INBOX_DATABASE_FILENAME,
} from '../src/finalization-recovery-store.js';
import type {
  VerifiedGraphScopedFinalizationEvidence,
} from '../src/finalization-graph-envelope.js';

const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const RAW = Uint8Array.from([1, 2, 3, 4]);

function received(overrides: Record<string, unknown> = {}) {
  return {
    key: 'entry-1',
    chainId: 'base:84532',
    contextGraphId: 'graph',
    sourcePeerId: '12D3KooWPublisher',
    ual: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
    txHash: TX_HASH,
    assertionVersion: '1',
    merkleRoot: `0x${'01'.repeat(32)}`,
    kaId: '7',
    batchId: '7',
    targetContextGraphId: '42',
    rawMessage: RAW,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<VerifiedGraphScopedFinalizationEvidence> = {},
): VerifiedGraphScopedFinalizationEvidence {
  return {
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    publicQuadsDigest: `sha256:${'02'.repeat(32)}`,
    publisherPeerId: '12D3KooWPublisher',
    publisherAddress: '0x2222222222222222222222222222222222222222',
    transactionHash: TX_HASH,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    txIndex: 4,
    authorAddress: '0x1111111111111111111111111111111111111111',
    accessPolicy: 'ownerOnly',
    allowedPeers: [],
    ...overrides,
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dkg-finalization-inbox-'));
}

async function leaveCommittedReceivedInCrashedWal(path: string): Promise<void> {
  const script = String.raw`
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const path = process.env.DKG_FINALIZATION_INBOX_PATH;
const raw = Buffer.from([1, 2, 3, 4]);
const digest = createHash('sha256').update(raw).digest('hex');
const database = new DatabaseSync(path);
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
database.prepare(
  "INSERT INTO finalization_inbox_v1 (key,state,chain_id,context_graph_id,ual,tx_hash,"
  + "assertion_version,merkle_root,ka_id,batch_id,envelope_sha256,raw_envelope,created_at,updated_at)"
  + " VALUES (?,'RECEIVED',?,?,?,?,?,?,?,?,?,?,?,?)"
).run(
  'crash-entry', 'base:84532', 'graph',
  'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
  '${TX_HASH}', '1', '0x${'01'.repeat(32)}', '7', '7', digest, raw, 1, 1
);
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: { ...process.env, DKG_FINALIZATION_INBOX_PATH: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(
      () => rejectReady(new Error(`finalization inbox crash child timed out: ${stderr}`)),
      10_000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `finalization inbox crash child exited early: code=${code} signal=${signal} ${stderr}`,
      ));
    });
  });
  const exit = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL');
  await exit;
}

describe('SQLite finalization recovery store', () => {
  it('migrates a v1 inbox in place without losing accepted entries', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, FINALIZATION_INBOX_DATABASE_FILENAME);
    try {
      const initial = await openSqliteFinalizationRecoveryStore(directory);
      await initial.receive(received());
      await initial.close();

      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        DROP INDEX finalization_pending_peer_v2;
        DROP INDEX finalization_pending_graph_v2;
        DROP INDEX finalization_pending_time_v2;
        DROP TABLE finalization_pending_v2;
        PRAGMA user_version = 1;
      `);
      legacy.close();

      const migrated = await openSqliteFinalizationRecoveryStore(directory);
      expect(await migrated.list()).toMatchObject([{ key: 'entry-1', state: 'RECEIVED' }]);
      const schema = new DatabaseSync(databasePath, { readOnly: true });
      expect(schema.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(schema.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'finalization_pending_v2'",
      ).get()?.name).toBe('finalization_pending_v2');
      schema.close();
      await migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lists only due live work in bounded oldest-first batches', async () => {
    const directory = await temporaryDirectory();
    try {
      let now = 1_000;
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        now: () => now,
      });
      await store.receive(received({ key: 'entry-1' }));
      await store.receive(received({ key: 'entry-2' }));
      await store.receive(received({ key: 'entry-3' }));
      await store.recordAttempt('entry-1', 0, 'busy', 1_000);
      await store.markVerified('entry-3', 0, evidence());
      await store.transition('entry-3', 0, 'SETTLED');

      await expect(store.listDue(16)).resolves.toMatchObject([
        { key: 'entry-2', state: 'RECEIVED' },
      ]);

      now = 2_000;
      await expect(store.listDue(16)).resolves.toMatchObject([
        { key: 'entry-2', state: 'RECEIVED', attemptCount: 0 },
        { key: 'entry-1', state: 'RECEIVED', attemptCount: 1 },
      ]);
      await expect(store.listDue(0)).resolves.toEqual([]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lists a SETTLED receipt retry only after its persisted deadline', async () => {
    const directory = await temporaryDirectory();
    try {
      let now = 1_000;
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        now: () => now,
      });
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await store.transition('entry-1', 0, 'SETTLED');
      await store.recordAttempt('entry-1', 0, 'receipt pending', 1_000);

      await expect(store.listDue(16)).resolves.toEqual([]);
      now = 2_000;
      await expect(store.listDue(16)).resolves.toMatchObject([
        { key: 'entry-1', state: 'SETTLED', lastError: 'receipt pending' },
      ]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never narrows a persisted retry deadline and reports due backlog health', async () => {
    const directory = await temporaryDirectory();
    try {
      let now = 1_000;
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        now: () => now,
      });
      await store.receive(received());
      await expect(store.health()).resolves.toMatchObject({
        dueEntries: 1,
        oldestDueAgeMs: 0,
      });

      await store.recordAttempt('entry-1', 0, 'long backoff', 10_000);
      expect(await store.get('entry-1')).toMatchObject({
        nextAttemptAt: 11_000,
      });
      await expect(store.health()).resolves.toMatchObject({ dueEntries: 0 });

      now = 1_500;
      await store.recordAttempt('entry-1', 0, 'duplicate without delay');
      await store.recordAttempt('entry-1', 0, 'shorter backoff', 100);
      expect(await store.get('entry-1')).toMatchObject({
        nextAttemptAt: 11_000,
      });

      await store.recordAttempt('entry-1', 0, 'longer backoff', 20_000);
      expect(await store.get('entry-1')).toMatchObject({
        nextAttemptAt: 21_500,
      });
      now = 21_500;
      await expect(store.health()).resolves.toMatchObject({
        dueEntries: 1,
        oldestDueAgeMs: 20_500,
      });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('durably transitions RECEIVED to VERIFIED to SETTLED across reopen', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      expect((await store.receive(received())).status).toBe('inserted');
      expect((await store.markVerified('entry-1', 0, evidence())).status).toBe('verified');
      expect(await store.transition('entry-1', 0, 'SETTLED')).toBe(true);
      await store.close();

      const reopened = await openSqliteFinalizationRecoveryStore(directory);
      expect(await reopened.list()).toMatchObject([{
        key: 'entry-1',
        state: 'SETTLED',
        envelopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        verifiedEvidence: {
          blockHash: BLOCK_HASH,
          txIndex: 4,
        },
      }]);
      await reopened.close();
      expect((await readFile(join(directory, FINALIZATION_INBOX_DATABASE_FILENAME))).length)
        .toBeGreaterThan(100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts SETTLED receipt retries with a fresh attempt budget', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      expect((await store.receive(received())).status).toBe('inserted');
      expect((await store.markVerified('entry-1', 0, evidence())).status).toBe('verified');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await store.recordAttempt('entry-1', 0, 'store scheduler remained busy', 1_000);
      }
      expect(await store.list()).toMatchObject([{
        state: 'VERIFIED',
        attemptCount: 4,
        lastError: 'store scheduler remained busy',
        nextAttemptAt: expect.any(Number),
      }]);

      expect(await store.transition('entry-1', 0, 'SETTLED')).toBe(true);
      expect(await store.list()).toMatchObject([{
        state: 'SETTLED',
        attemptCount: 0,
      }]);
      const [settled] = await store.list();
      expect(settled).not.toHaveProperty('lastError');
      expect(settled).not.toHaveProperty('nextAttemptAt');
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never merges conflicting bytes when delivery provenance also changes', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());
      await expect(store.receive(received({
        rawMessage: Uint8Array.from([9]),
        sourcePeerId: '12D3KooWAttacker',
      }))).resolves.toEqual({ status: 'conflict' });
      expect(await store.list()).toMatchObject([{
        state: 'RECEIVED',
        sourcePeerId: '12D3KooWPublisher',
        rawMessage: RAW,
      }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts byte-identical duplicates from another delivery peer', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await expect(store.receive(received({
        sourcePeerId: '12D3KooWUntrustedRelay',
      }))).resolves.toMatchObject({ status: 'inserted' });
      await expect(store.receive(received({
        sourcePeerId: '12D3KooWPublisher',
      }))).resolves.toMatchObject({
        status: 'existing',
        entry: {
          state: 'RECEIVED',
          sourcePeerId: '12D3KooWUntrustedRelay',
          rawMessage: RAW,
        },
      });
      expect(await store.list()).toHaveLength(1);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records publisher authority monotonically for the current generation', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      expect((await store.receive(received({
        sourcePeerId: '12D3KooWUntrustedRelay',
      }))).status).toBe('inserted');

      await expect(store.recordTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWPublisher',
      )).resolves.toBe(true);
      await expect(store.recordTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWPublisher',
      )).resolves.toBe(true);
      await expect(store.recordTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWAttacker',
      )).resolves.toBe(false);
      expect(await store.list()).toMatchObject([{
        state: 'RECEIVED',
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
      }]);

      expect(await store.markReorged('entry-1', 0, 'canonical reorg')).toBe(true);
      await expect(store.recordTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWPublisher',
      )).resolves.toBe(false);
      expect(await store.list()).toMatchObject([{
        state: 'REORGED',
        generation: 1,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
      }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('durably records and consumes a pending settled publisher upgrade', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      expect((await store.receive(received({
        sourcePeerId: '12D3KooWUntrustedRelay',
      }))).status).toBe('inserted');
      expect((await store.markVerified('entry-1', 0, evidence())).status).toBe('verified');
      expect(await store.transition('entry-1', 0, 'SETTLED')).toBe(true);
      await store.recordAttempt('entry-1', 0, 'old settled retry', 1_000);

      await expect(store.recordSettledPublisherUpgrade(
        'entry-1',
        0,
        '12D3KooWPublisher',
      )).resolves.toMatchObject({
        status: 'recorded',
        entry: {
          state: 'SETTLED',
          generation: 0,
          publisherUpgradePending: true,
          trustedPublisherPeerId: '12D3KooWPublisher',
          attemptCount: 1,
          lastError: 'old settled retry',
          verifiedEvidence: {
            accessPolicy: 'ownerOnly',
          },
        },
      });
      await expect(store.recordSettledPublisherUpgrade(
        'entry-1',
        0,
        '12D3KooWPublisher',
      )).resolves.toMatchObject({ status: 'existing' });
      await expect(store.recordSettledPublisherUpgrade(
        'entry-1',
        0,
        '12D3KooWAttacker',
      )).resolves.toEqual({ status: 'conflict' });
      await expect(store.recordSettledPublisherUpgrade(
        'entry-1',
        1,
        '12D3KooWPublisher',
      )).resolves.toEqual({ status: 'conflict' });
      await expect(store.rearmSettledWithTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWAttacker',
        'untrusted late authority',
      )).resolves.toBe(false);
      await expect(store.rearmSettledWithTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWPublisher',
        'trusted publisher access semantics arrived after settlement',
      )).resolves.toBe(true);
      await expect(store.rearmSettledWithTrustedPublisher(
        'entry-1',
        0,
        '12D3KooWPublisher',
        'stale generation',
      )).resolves.toBe(false);

      const [rearmed] = await store.list();
      expect(rearmed).toMatchObject({
        state: 'REORGED',
        generation: 1,
        sourcePeerId: '12D3KooWUntrustedRelay',
        trustedPublisherPeerId: '12D3KooWPublisher',
        rawMessage: RAW,
        publisherUpgradePending: true,
        attemptCount: 0,
        lastError: 'trusted publisher access semantics arrived after settlement',
      });
      expect(rearmed).not.toHaveProperty('verifiedEvidence');
      expect(rearmed).not.toHaveProperty('nextAttemptAt');

      expect((await store.markVerified('entry-1', 1, evidence({
        accessPolicy: 'allowList',
        allowedPeers: ['12D3KooWReader'],
      }))).status).toBe('verified');
      expect(await store.transition('entry-1', 1, 'SETTLED')).toBe(true);
      expect(await store.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 1,
        publisherUpgradePending: false,
        trustedPublisherPeerId: '12D3KooWPublisher',
        verifiedEvidence: {
          accessPolicy: 'allowList',
          allowedPeers: ['12D3KooWReader'],
        },
      }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('invalidates reorged evidence while retaining the immutable recovery envelope', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      expect((await store.receive(received())).status).toBe('inserted');
      expect((await store.markVerified('entry-1', 0, evidence())).status).toBe('verified');
      await expect(store.markReorged(
        'entry-1',
        0,
        'persisted receipt disagrees with canonical chain truth',
      )).resolves.toBe(true);

      const [reorged] = await store.list();
      expect(reorged).toMatchObject({
        state: 'REORGED',
        generation: 1,
        lastError: 'persisted receipt disagrees with canonical chain truth',
      });
      expect(reorged).not.toHaveProperty('verifiedEvidence');
      await store.close();

      const reopened = await openSqliteFinalizationRecoveryStore(directory);
      expect(await reopened.list()).toMatchObject([{
        state: 'REORGED',
        generation: 1,
      }]);
      const repeated = await reopened.receive(received({
        rawMessage: Uint8Array.from([1, 2, 3, 5]),
      }));
      expect(repeated).toEqual({ status: 'conflict' });
      await expect(reopened.receive(received())).resolves.toMatchObject({
        status: 'existing',
        entry: { state: 'REORGED', generation: 1, rawMessage: RAW },
      });
      await expect(reopened.markVerified('entry-1', 0, evidence()))
        .resolves.toEqual({ status: 'conflict' });

      const replacementEvidence = evidence({
        blockNumber: 124,
        blockHash: `0x${'ef'.repeat(32)}`,
      });
      expect((await reopened.markVerified('entry-1', 1, replacementEvidence)).status)
        .toBe('verified');
      expect(await reopened.list()).toMatchObject([{
        state: 'VERIFIED',
        generation: 1,
        verifiedEvidence: {
          blockNumber: 124,
          blockHash: `0x${'ef'.repeat(32)}`,
        },
      }]);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('makes a byte-identical SETTLED envelope revalidatable but rejects changed bytes', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await store.transition('entry-1', 0, 'SETTLED');

      await expect(store.receive(received())).resolves.toMatchObject({
        status: 'existing',
        entry: { state: 'SETTLED', generation: 0 },
      });
      await expect(store.receive(received({
        rawMessage: Uint8Array.from([1, 2, 3, 5]),
      }))).resolves.toEqual({ status: 'conflict' });
      await expect(store.receive(received({
        assertionVersion: '2',
        rawMessage: Uint8Array.from([1, 2, 3, 6]),
      }))).resolves.toEqual({ status: 'conflict' });
      await expect(store.markReorged(
        'entry-1',
        0,
        'settled receipt disagrees with canonical chain truth',
      )).resolves.toBe(true);
      expect(await store.list()).toMatchObject([{
        state: 'REORGED',
        generation: 1,
        rawMessage: RAW,
        lastError: 'settled receipt disagrees with canonical chain truth',
      }]);
      expect((await store.list())[0]).not.toHaveProperty('verifiedEvidence');
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not rearm a reorged transaction with conflicting event identity', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await store.markReorged('entry-1', 0, 'canonical reorg');

      await expect(store.receive(received({
        assertionVersion: '2',
        rawMessage: Uint8Array.from([1, 2, 3, 5]),
      }))).resolves.toEqual({ status: 'conflict' });
      expect(await store.list()).toMatchObject([{
        state: 'REORGED',
        generation: 1,
      }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not attach canonical evidence to a different transaction or assertion', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());
      await expect(store.markVerified('entry-1', 0, evidence({
        transactionHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'conflict' });
      await expect(store.markVerified('entry-1', 0, evidence({
        assertionVersion: '2',
      }))).resolves.toEqual({ status: 'conflict' });
      expect(await store.list()).toMatchObject([{ state: 'RECEIVED' }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('durably defers a new envelope when live capacity is full', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, { maxEntries: 1 });
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      expect(await store.list()).toMatchObject([{ key: 'entry-1', state: 'VERIFIED' }]);
      expect(await store.health()).toMatchObject({
        available: true,
        ready: false,
        degradedReason: 'capacity-exhausted',
        deferredEntries: 1,
      });

      await store.transition('entry-1', 0, 'SETTLED');
      await expect(store.promotePending(16)).resolves.toBe(1);
      expect(await store.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'entry-2', state: 'RECEIVED' }),
      ]));
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the durable deferred lane bounded and reports hard exhaustion', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 1,
        maxDeferredPerPeer: 1,
        maxDeferredPerContextGraph: 1,
      });
      await store.receive(received());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'entry-3',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'capacity' });
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not let a quota-blocked oldest graph starve a later eligible graph', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 2,
        maxPerPeer: 8,
        maxPerContextGraph: 1,
      });
      await store.receive(received({
        key: 'live-graph-a',
        contextGraphId: 'graph-a',
        txHash: `0x${'a1'.repeat(32)}`,
      }));
      await store.receive(received({
        key: 'live-graph-x',
        contextGraphId: 'graph-x',
        txHash: `0x${'a2'.repeat(32)}`,
      }));
      await expect(store.receive(received({
        key: 'pending-graph-a',
        contextGraphId: 'graph-a',
        txHash: `0x${'b1'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'pending-graph-b',
        contextGraphId: 'graph-b',
        txHash: `0x${'b2'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });

      await store.transition('live-graph-x', 0, 'SUPERSEDED');
      await expect(store.promotePending(1)).resolves.toBe(1);
      expect(await store.get('pending-graph-b')).toMatchObject({
        key: 'pending-graph-b',
        state: 'RECEIVED',
      });
      expect(await store.get('pending-graph-a')).toBeUndefined();
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the 129th envelope durably and promotes it after the 128-entry backlog drains', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 128,
        maxPerPeer: 128,
        maxPerContextGraph: 128,
      });
      for (let index = 0; index < 128; index += 1) {
        await expect(store.receive(received({
          key: `entry-${index}`,
          txHash: `0x${index.toString(16).padStart(64, '0')}`,
          kaId: String(index),
        }))).resolves.toMatchObject({ status: 'inserted' });
      }
      const overflow = received({
        key: 'entry-128',
        txHash: `0x${'ff'.repeat(32)}`,
        kaId: '128',
      });
      await expect(store.receive(overflow)).resolves.toEqual({ status: 'pending' });
      expect(await store.health()).toMatchObject({
        deferredEntries: 1,
        dueEntries: 128,
      });

      await store.transition('entry-0', 0, 'SUPERSEDED');
      await expect(store.promotePending(16)).resolves.toBe(1);
      expect(await store.get('entry-128')).toMatchObject({
        state: 'RECEIVED',
        kaId: '128',
      });
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes concurrent duplicate admission without duplicate rows', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.receive(received())));
      expect(outcomes.filter((result) => result.status === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'existing')).toHaveLength(11);
      expect(await store.list()).toHaveLength(1);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains already accepted mutations before checkpointing on close', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      const first = store.receive(received());
      const second = store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }));
      const closing = store.close();
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { status: 'inserted' },
        { status: 'inserted' },
      ]);
      await closing;

      const reopened = await openSqliteFinalizationRecoveryStore(directory);
      expect(await reopened.list()).toHaveLength(2);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a committed RECEIVED row after a process crash with a hot WAL', async () => {
    const directory = await temporaryDirectory();
    try {
      const initial = await openSqliteFinalizationRecoveryStore(directory);
      const path = initial.databasePath;
      await initial.close();

      await leaveCommittedReceivedInCrashedWal(path);
      expect(existsSync(`${path}-wal`)).toBe(true);

      const recovered = await openSqliteFinalizationRecoveryStore(directory);
      expect(await recovered.list()).toMatchObject([{
        key: 'crash-entry',
        state: 'RECEIVED',
        rawMessage: RAW,
      }]);
      await recovered.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('can supersede RECEIVED before canonical receipt verification', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      await store.receive(received());
      await expect(store.transition('entry-1', 0, 'SUPERSEDED', 'newer assertion'))
        .resolves.toBe(true);
      const entries = await store.list();
      expect(entries).toMatchObject([{ state: 'SUPERSEDED' }]);
      expect(entries[0]).not.toHaveProperty('verifiedEvidence');
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('expires stale raw RECEIVED envelopes without evicting VERIFIED evidence', async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        rawTtlMs: 100,
        now: () => now,
      });
      await store.receive(received());
      await store.receive(received({
        key: 'verified',
        txHash: `0x${'ef'.repeat(32)}`,
      }));
      await store.markVerified('verified', 0, evidence({
        transactionHash: `0x${'ef'.repeat(32)}`,
      }));
      now += 101;
      await store.receive(received({
        key: 'trigger',
        txHash: `0x${'12'.repeat(32)}`,
      }));
      expect(await store.list()).toMatchObject([
        { key: 'verified', state: 'VERIFIED' },
        { key: 'trigger', state: 'RECEIVED' },
      ]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds terminal diagnostic rows by count', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxTerminalEntries: 2,
      });
      for (let index = 1; index <= 3; index += 1) {
        const key = `entry-${index}`;
        await store.receive(received({
          key,
          txHash: `0x${index.toString(16).padStart(64, '0')}`,
        }));
        await store.transition(key, 0, 'SUPERSEDED', 'newer assertion');
      }
      const entries = await store.list();
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.state === 'SUPERSEDED')).toBe(true);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a pending settled publisher upgrade outside terminal pruning', async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxTerminalEntries: 1,
        now: () => now,
      });
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await store.transition('entry-1', 0, 'SETTLED');
      await store.recordSettledPublisherUpgrade(
        'entry-1',
        0,
        '12D3KooWPublisher',
      );

      for (let index = 2; index <= 3; index += 1) {
        now += 1;
        const key = `entry-${index}`;
        await store.receive(received({
          key,
          txHash: `0x${index.toString(16).padStart(64, '0')}`,
        }));
        await store.transition(key, 0, 'SUPERSEDED', 'newer assertion');
      }

      expect(await store.list()).toMatchObject([
        {
          key: 'entry-1',
          state: 'SETTLED',
          publisherUpgradePending: true,
        },
        {
          key: 'entry-3',
          state: 'SUPERSEDED',
          publisherUpgradePending: false,
        },
      ]);
      await expect(store.health()).resolves.toMatchObject({
        stateCounts: { SETTLED: 1, SUPERSEDED: 1 },
        livePayloadBytes: RAW.byteLength,
      });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses owner-only files and fails closed on a foreign database', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      const path = store.databasePath;
      await store.close();
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      await rm(path);
      const foreign = new DatabaseSync(path);
      foreign.exec('CREATE TABLE foreign_data (value TEXT); PRAGMA application_id = 305419896;');
      foreign.close();
      const before = await readFile(path);
      await expect(openSqliteFinalizationRecoveryStore(directory)).rejects.toThrow();
      expect(await readFile(path)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when indexed provenance disagrees with the evidence record', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      const path = store.databasePath;
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await store.close();

      const database = new DatabaseSync(path);
      database.exec('UPDATE finalization_inbox_v1 SET tx_index = tx_index + 1');
      database.close();

      await expect(openSqliteFinalizationRecoveryStore(directory))
        .rejects.toThrow(/inconsistent verified provenance/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses orphaned symlink sidecars', async () => {
    const directory = await temporaryDirectory();
    try {
      const target = join(directory, 'outside');
      await writeFile(target, 'outside');
      await symlink(target, join(directory, `${FINALIZATION_INBOX_DATABASE_FILENAME}-wal`));
      await expect(openSqliteFinalizationRecoveryStore(directory))
        .rejects.toThrow(/orphaned SQLite sidecar/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
