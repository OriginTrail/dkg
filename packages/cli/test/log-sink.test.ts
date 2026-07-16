import { describe, it, expect } from 'vitest';
import { createLogRedactor, type LogRecord } from '@origintrail-official/dkg-core';
import { createDaemonLogSink, type RemoteLogShipper } from '../src/daemon/log-sink.js';

/**
 * Review coverage gap (PR #1317): the daemon log-sink fan-out is the trust
 * boundary where the LOCAL DB keeps the full record but remote shippers get only
 * a REDACTED copy. These tests exercise the actual fan-out wiring (not just the
 * standalone redactor) so a regression that forwarded the raw record, or skipped
 * a shipper / redaction, fails the build.
 */
function rec(over: Partial<LogRecord> = {}): LogRecord {
  return { level: 'info', operationName: 'publish', operationId: 'op-1', module: 'test', message: 'hello', ...over };
}
function shipper(): RemoteLogShipper & { sent: LogRecord[] } {
  const sent: LogRecord[] = [];
  return { sent, push: (r) => sent.push(r) };
}

const SECRET_MSG = 'loaded operationalWalletPrivateKey=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef custom_secret=topsecret';

describe('daemon log sink — full local, redacted remote', () => {
  it('stores the ORIGINAL locally but ships a REDACTED copy to every active shipper', () => {
    const stored: any[] = [];
    const syslog = shipper();
    const otlp = shipper();
    const sink = createDaemonLogSink({
      insertLog: (r) => stored.push(r),
      redact: createLogRedactor(['custom_secret']), // operator extra key honored
      remoteShippers: () => [syslog, otlp],
      now: () => 1234,
    });

    sink(rec({ message: SECRET_MSG }));

    // Local DB: full fidelity (the secret is intact for the operator's own debugging).
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe(SECRET_MSG);
    expect(stored[0].ts).toBe(1234);

    // Both remote shippers: redacted, identical, secrets gone.
    for (const s of [syslog, otlp]) {
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].message).toContain('[REDACTED]');
      expect(s.sent[0].message).not.toContain('deadbeef');
      expect(s.sent[0].message).not.toContain('topsecret');
    }
  });

  it('pushes to NO remote shipper when none are active (logs stay local)', () => {
    const stored: any[] = [];
    const sink = createDaemonLogSink({
      insertLog: (r) => stored.push(r),
      redact: createLogRedactor(),
      remoteShippers: () => [null, undefined], // exporter:'none' / disabled
    });
    sink(rec({ message: SECRET_MSG }));
    expect(stored).toHaveLength(1); // local copy still written
  });

  it('skips null shippers but still ships to the active one', () => {
    const otlp = shipper();
    const sink = createDaemonLogSink({
      insertLog: () => {},
      redact: createLogRedactor(),
      remoteShippers: () => [null, otlp], // syslog off, OTLP on
    });
    sink(rec({ message: SECRET_MSG }));
    expect(otlp.sent).toHaveLength(1);
    expect(otlp.sent[0].message).not.toContain('deadbeef');
  });

  it('a thrown DB write never breaks the node and remote shipping still happens', () => {
    const otlp = shipper();
    const sink = createDaemonLogSink({
      insertLog: () => { throw new Error('db down'); },
      redact: createLogRedactor(),
      remoteShippers: () => [otlp],
    });
    expect(() => sink(rec({ message: SECRET_MSG }))).not.toThrow();
    expect(otlp.sent).toHaveLength(1);
  });
});
