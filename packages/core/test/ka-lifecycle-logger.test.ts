import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Logger, type LogSink } from '../src/logger.js';
import {
  KA_LIFECYCLE_ROLES,
  KA_LIFECYCLE_STAGES,
  isKaLifecycleDebugLoggingEnabled,
  logKaLifecycleEvent,
  resolveKaLifecycleLogDetail,
  setKaLifecycleDebugLoggingEnabled,
} from '../src/ka-lifecycle-logger.js';
import {
  KA_LIFECYCLE_STAGES as ROOT_KA_LIFECYCLE_STAGES,
  logKaLifecycleEvent as rootLogKaLifecycleEvent,
} from '../src/index.js';

interface LogEntry {
  level: string;
  operationName: string;
  operationId: string;
  sourceOperationId?: string;
  module: string;
  message: string;
}

const KA_DEBUG_ENV_KEYS = [
  'DKG_DEBUG_KA_LIFECYCLE',
  'DKG_KA_LIFECYCLE_DEBUG',
  'DKG_DEBUG_PUBLISH_LIFECYCLE',
] as const;
const originalDebugEnv = new Map<string, string | undefined>();
for (const key of KA_DEBUG_ENV_KEYS) originalDebugEnv.set(key, process.env[key]);

function collectSink(): { entries: LogEntry[]; sink: LogSink } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

function captureStdout<T>(fn: () => T): { result: T; output: string[] } {
  const output: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stdout.write = orig;
  return { result, output };
}

function captureStderr<T>(fn: () => T): { result: T; output: string[] } {
  const output: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stderr.write = orig;
  return { result, output };
}

describe('KA lifecycle logging', () => {
  beforeEach(() => {
    for (const key of KA_DEBUG_ENV_KEYS) delete process.env[key];
    setKaLifecycleDebugLoggingEnabled(undefined);
  });

  afterEach(() => {
    Logger.setSink(null);
    setKaLifecycleDebugLoggingEnabled(undefined);
    for (const key of KA_DEBUG_ENV_KEYS) {
      const original = originalDebugEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it('emits an assetUal-correlated lifecycle log with node metadata and severity', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('KALifecycle');
    captureStderr(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-1', operationName: 'publish' }, {
        level: 'warn',
        assetUal: 'did:dkg:otp:2043/0xasset/42',
        stage: 'storage_ack',
        event: 'ack.declined',
        role: 'publisher',
        localPeerId: '12D3KooWLocalPeerFullIdentifier',
        localNodeIdentityId: 'node-identity-local-full',
        peer: '12D3KooWRemotePeerFullIdentifier',
        peerNodeIdentityId: 'node-identity-remote-full',
        metadata: {
          reason: 'missing-replication-window',
          retryAfterMs: 2500,
        },
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].module).toBe('KALifecycle');
    expect(entries[0].message).toContain('assetUal=did:dkg:otp:2043/0xasset/42');
    expect(entries[0].message).toContain('stage=storage_ack');
    expect(entries[0].message).toContain('event=ack.declined');
    expect(entries[0].message).toContain('role=publisher');
    expect(entries[0].message).toContain('localPeerId=12D3KooWLocalPeerFullIdentifier');
    expect(entries[0].message).toContain('localNodeIdentityId=node-identity-local-full');
    expect(entries[0].message).toContain('peer=12D3KooWRemotePeerFullIdentifier');
    expect(entries[0].message).toContain('peerNodeIdentityId=node-identity-remote-full');
    expect(entries[0].message).toContain('reason=missing-replication-window');
    expect(entries[0].message).toContain('retryAfterMs=2500');
  });

  it('redacts unsafe payload metadata while preserving full identifiers', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const rawTriples = '<urn:asset> <urn:privatePredicate> "private payload snippet" .';
    const ciphertext = `0x${'ab'.repeat(96)}`;
    const privatePayloadSnippet = 'customer secret payload sample';
    const peerDetail = `remote-peer-said-${'x'.repeat(360)}`;
    const fullPeer = `12D3KooW${'p'.repeat(72)}`;

    const log = new Logger('KALifecycle');
    captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-2', operationName: 'publish' }, {
        assetUal: 'did:dkg:otp:2043/0xasset/43',
        stage: 'swm_share',
        event: 'share.received',
        detail: 'summary',
        role: 'receiver',
        localPeerId: '12D3KooWReceiverPeerFullIdentifier',
        localNodeIdentityId: 'node-identity-receiver-full',
        peer: fullPeer,
        metadata: {
          rawTriples,
          ciphertext,
          privatePayloadSnippet,
          peerDetail,
          graphCount: 2,
        },
      }),
    );

    const message = entries[0].message;
    expect(message).toContain(`peer=${fullPeer}`);
    expect(message).toContain('graphCount=2');
    expect(message).not.toContain(rawTriples);
    expect(message).not.toContain(ciphertext);
    expect(message).not.toContain(privatePayloadSnippet);
    expect(message).not.toContain(peerDetail);
    expect(message).toContain('rawTriples=[REDACTED]');
    expect(message).toContain('ciphertext=[REDACTED]');
    expect(message).toContain('privatePayloadSnippet=[REDACTED]');
    expect(message).toContain('peerDetail=');
    expect(message.length).toBeLessThan(700);
  });

  it('escapes whitespace and control characters so lifecycle values cannot inject log rows', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const injectedAssetUal = 'did:dkg:evm:31337/0xaaa/1\nka_lifecycle assetUal=did:dkg:evm:31337/0xvictim/2 stage=chain event=confirm role=publisher';
    const log = new Logger('KALifecycle');
    const { output } = captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-injection', operationName: 'publish' }, {
        assetUal: injectedAssetUal,
        stage: 'storage_ack',
        event: 'storage_ack_declined',
        role: 'receiver',
        localPeerId: '12D3KooWReceiverPeerFullIdentifier',
        localNodeIdentityId: 'node-identity-receiver-full',
        metadata: {
          reason: 'No local Sender Key state for 0xabc epoch e1',
        },
      }),
    );

    expect(entries).toHaveLength(1);
    expect(output).toHaveLength(1);
    expect(output[0].split('\n').filter((line) => line.includes('ka_lifecycle'))).toHaveLength(1);
    expect(entries[0].message).not.toContain('\n');
    expect(entries[0].message).toContain('assetUal="did:dkg:evm:31337/0xaaa/1\\nka_lifecycle');
    expect(entries[0].message).toContain('reason="No local Sender Key state for 0xabc epoch e1"');
  });

  it('redacts sensitive payload-shaped values even under otherwise safe metadata keys', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const leakedTriple = '<urn:asset> <urn:privatePredicate> "secret" .';
    const leakedCiphertext = `0x${'cd'.repeat(96)}`;
    const log = new Logger('KALifecycle');
    captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-redact-value', operationName: 'publish' }, {
        assetUal: 'did:dkg:evm:31337/0xaaa/1',
        stage: 'swm_share',
        event: 'swm_update_rejected',
        role: 'receiver',
        localPeerId: '12D3KooWReceiverPeerFullIdentifier',
        localNodeIdentityId: 'node-identity-receiver-full',
        metadata: {
          reason: `validation failed for ${leakedTriple}`,
          declineMessage: `ciphertext mismatch ${leakedCiphertext}`,
          peerDetail: 'private payload customer secret payload sample',
        },
      }),
    );

    const message = entries[0].message;
    expect(message).not.toContain(leakedTriple);
    expect(message).not.toContain(leakedCiphertext);
    expect(message).not.toContain('customer secret payload sample');
    expect(message).toContain('reason=[REDACTED]');
    expect(message).toContain('declineMessage=[REDACTED]');
    expect(message).toContain('peerDetail=[REDACTED]');
  });

  it('keeps full asset and peer identifiers even when metadata strings are bounded', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const longAssetUal = `did:dkg:otp:2043/0xasset/${'a'.repeat(220)}`;
    const longLocalPeerId = `12D3KooW${'l'.repeat(220)}`;
    const longLocalNodeIdentityId = `node-identity-${'n'.repeat(220)}`;
    const longPeer = `12D3KooW${'p'.repeat(220)}`;
    const longPeerNodeIdentityId = `peer-node-identity-${'r'.repeat(220)}`;

    const log = new Logger('KALifecycle');
    captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-3', operationName: 'publish' }, {
        assetUal: longAssetUal,
        stage: 'finalization',
        event: 'gossip.received',
        detail: 'summary',
        role: 'receiver',
        localPeerId: longLocalPeerId,
        localNodeIdentityId: longLocalNodeIdentityId,
        peer: longPeer,
        peerNodeIdentityId: longPeerNodeIdentityId,
        metadata: {
          peerDetail: `remote-peer-said-${'z'.repeat(360)}`,
        },
      }),
    );

    const message = entries[0].message;
    expect(message).toContain(`assetUal=${longAssetUal}`);
    expect(message).toContain(`localPeerId=${longLocalPeerId}`);
    expect(message).toContain(`localNodeIdentityId=${longLocalNodeIdentityId}`);
    expect(message).toContain(`peer=${longPeer}`);
    expect(message).toContain(`peerNodeIdentityId=${longPeerNodeIdentityId}`);
    expect(message).toContain('peerDetail=');
    expect(message).toContain('[truncated:');
  });

  it('supports the agreed lifecycle stage and role tokens', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    expect(KA_LIFECYCLE_STAGES).toEqual([
      'identity',
      'wm',
      'swm_share',
      'sender_key',
      'storage_ack',
      'chain',
      'vm',
      'finalization',
    ]);
    expect(KA_LIFECYCLE_ROLES).toEqual(['publisher', 'receiver']);

    const log = new Logger('KALifecycle');
    captureStdout(() => {
      for (const stage of KA_LIFECYCLE_STAGES) {
        logKaLifecycleEvent(log, { operationId: `op-${stage}`, operationName: 'publish' }, {
          assetUal: `did:dkg:otp:2043/0xasset/${stage}`,
          stage,
          event: `${stage}.progress`,
          detail: 'summary',
          role: 'publisher',
          localPeerId: '12D3KooWLocalPeerFullIdentifier',
          localNodeIdentityId: 'node-identity-local-full',
        });
      }
    });

    expect(entries.map((entry) => entry.message)).toEqual(
      KA_LIFECYCLE_STAGES.map((stage) =>
        expect.stringContaining(`stage=${stage}`),
      ),
    );
    expect(entries.every((entry) => entry.message.includes('role=publisher'))).toBe(true);
  });

  it('suppresses detailed lifecycle events unless KA lifecycle debug logging is enabled', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('KALifecycle');
    const { output } = captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-detail', operationName: 'publish' }, {
        assetUal: 'did:dkg:otp:2043/0xasset/detail',
        stage: 'storage_ack',
        event: 'success',
        role: 'publisher',
        localPeerId: 'publisher-peer',
        localNodeIdentityId: 'publisher-node',
      }),
    );

    expect(resolveKaLifecycleLogDetail({
      assetUal: 'did:dkg:otp:2043/0xasset/detail',
      stage: 'storage_ack',
      event: 'success',
      role: 'publisher',
      localPeerId: 'publisher-peer',
      localNodeIdentityId: 'publisher-node',
    })).toBe('debug');
    expect(isKaLifecycleDebugLoggingEnabled()).toBe(false);
    expect(entries).toHaveLength(0);
    expect(output).toHaveLength(0);
  });

  it('lets config override the compatibility env debug flag', () => {
    process.env.DKG_DEBUG_KA_LIFECYCLE = '1';
    setKaLifecycleDebugLoggingEnabled(false);
    expect(isKaLifecycleDebugLoggingEnabled()).toBe(false);

    setKaLifecycleDebugLoggingEnabled(true);
    expect(isKaLifecycleDebugLoggingEnabled()).toBe(true);
  });

  it('emits detailed lifecycle events when the KA lifecycle debug flag is enabled', () => {
    process.env.DKG_DEBUG_KA_LIFECYCLE = '1';
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('KALifecycle');
    const { output } = captureStdout(() =>
      logKaLifecycleEvent(log, { operationId: 'op-ka-debug-detail', operationName: 'publish' }, {
        assetUal: 'did:dkg:otp:2043/0xasset/detail',
        stage: 'storage_ack',
        event: 'success',
        role: 'publisher',
        localPeerId: 'publisher-peer',
        localNodeIdentityId: 'publisher-node',
      }),
    );

    expect(isKaLifecycleDebugLoggingEnabled()).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain('stage=storage_ack');
    expect(entries[0].message).toContain('event=success');
    expect(output).toHaveLength(1);
  });

  it('exports the lifecycle helper and tokens from the package root', () => {
    expect(rootLogKaLifecycleEvent).toBe(logKaLifecycleEvent);
    expect(ROOT_KA_LIFECYCLE_STAGES).toBe(KA_LIFECYCLE_STAGES);
  });
});
