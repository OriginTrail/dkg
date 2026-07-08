import { describe, it, expect, afterEach } from 'vitest';
import {
  Logger,
  KA_LIFECYCLE_ROLES,
  KA_LIFECYCLE_STAGES,
  createOperationContext,
  logKaLifecycleEvent,
  type LogSink,
  type OperationContext,
} from '../src/logger.js';

interface LogEntry {
  level: string;
  operationName: string;
  operationId: string;
  sourceOperationId?: string;
  module: string;
  message: string;
}

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

function captureBoth<T>(fn: () => T): { result: T; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => { stdout.push(String(chunk)); return true; }) as any;
  process.stderr.write = ((chunk: any) => { stderr.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  return { result, stdout, stderr };
}

describe('Logger', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  function ctx(overrides?: Partial<OperationContext>): OperationContext {
    return { operationId: 'op-123', operationName: 'publish', ...overrides };
  }

  it('info writes to stdout and invokes sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('TestModule');
    const { output } = captureStdout(() => log.info(ctx(), 'hello world'));

    expect(output.length).toBe(1);
    expect(output[0]).toContain('publish');
    expect(output[0]).toContain('op-123');
    expect(output[0]).toContain('[TestModule]');
    expect(output[0]).toContain('hello world');
    expect(output[0]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].operationName).toBe('publish');
    expect(entries[0].operationId).toBe('op-123');
    expect(entries[0].module).toBe('TestModule');
    expect(entries[0].message).toBe('hello world');
  });

  it('warn writes to stderr with [WARN] tag', () => {
    const log = new Logger('WarnModule');
    const { output } = captureStderr(() => log.warn(ctx(), 'something iffy'));

    expect(output.length).toBe(1);
    expect(output[0]).toContain('[WARN]');
    expect(output[0]).toContain('something iffy');
  });

  it('error writes to stderr with [ERROR] tag', () => {
    const log = new Logger('ErrorModule');
    const { output } = captureStderr(() => log.error(ctx(), 'broke'));

    expect(output[0]).toContain('[ERROR]');
  });

  it('debug does not write to stdout/stderr — only invokes sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('DebugModule');
    const { stdout, stderr } = captureBoth(() => log.debug(ctx(), 'trace detail'));

    expect(stdout.length).toBe(0);
    expect(stderr.length).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('debug');
  });

  it('includes sourceOperationId in sink and formatted output when present', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('Mod');
    const { output } = captureStdout(() =>
      log.info(ctx({ sourceOperationId: 'remote-op-456' }), 'propagated'),
    );

    expect(output[0]).toContain('[from:remote-op-456]');
    expect(entries[0].sourceOperationId).toBe('remote-op-456');
  });

  it('omits [from:...] when sourceOperationId is undefined', () => {
    const log = new Logger('Mod');
    const { output } = captureStdout(() => log.info(ctx(), 'local only'));

    expect(output[0]).not.toContain('[from:');
  });

  it('setSink(null) clears the sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);
    Logger.setSink(null);

    const log = new Logger('X');
    log.debug(ctx(), 'ignored');

    expect(entries.length).toBe(0);
  });

  it('sink receives all four levels', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('M');
    captureBoth(() => {
      log.debug(ctx(), 'd');
      log.info(ctx(), 'i');
      log.warn(ctx(), 'w');
      log.error(ctx(), 'e');
    });

    const levels = entries.map(e => e.level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('KA lifecycle logging', () => {
  afterEach(() => {
    Logger.setSink(null);
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
      'sync',
      'reconcile',
    ]);
    expect(KA_LIFECYCLE_ROLES).toEqual(['publisher', 'receiver', 'sync']);

    const log = new Logger('KALifecycle');
    captureStdout(() => {
      for (const stage of KA_LIFECYCLE_STAGES) {
        logKaLifecycleEvent(log, { operationId: `op-${stage}`, operationName: 'publish' }, {
          assetUal: `did:dkg:otp:2043/0xasset/${stage}`,
          stage,
          event: `${stage}.progress`,
          role: 'sync',
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
    expect(entries.every((entry) => entry.message.includes('role=sync'))).toBe(true);
  });
});

describe('createOperationContext', () => {
  it('generates a UUID-shaped operationId', () => {
    const ctx = createOperationContext('query');
    expect(ctx.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ctx.operationName).toBe('query');
    expect(ctx.sourceOperationId).toBeUndefined();
  });

  it('includes sourceOperationId when provided', () => {
    const ctx = createOperationContext('sync', 'remote-op');
    expect(ctx.sourceOperationId).toBe('remote-op');
  });

  it('generates unique IDs across calls', () => {
    const a = createOperationContext('publish');
    const b = createOperationContext('publish');
    expect(a.operationId).not.toBe(b.operationId);
  });
});
