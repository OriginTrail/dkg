import { describe, it, expect } from 'vitest';
import { createLogRedactor, type LogRecord } from '@origintrail-official/dkg-core';
import { createDaemonLogSink, type RemoteLogShipper } from '../src/daemon/log-sink.js';

/**
 * The daemon log-sink fan-out is the trust boundary where remote shippers get
 * only a REDACTED copy. Local logging is already handled by daemon.log and must
 * not add a synchronous SQLite write per record.
 */
function rec(over: Partial<LogRecord> = {}): LogRecord {
  return { level: 'info', operationName: 'publish', operationId: 'op-1', module: 'test', message: 'hello', ...over };
}
function shipper(): RemoteLogShipper & { sent: LogRecord[] } {
  const sent: LogRecord[] = [];
  return { sent, push: (r) => sent.push(r) };
}

const SECRET_MSG = 'loaded operationalWalletPrivateKey=0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef custom_secret=topsecret';

describe('daemon log sink — redacted remote only', () => {
  it('ships one REDACTED copy to every active shipper', () => {
    const syslog = shipper();
    const otlp = shipper();
    const sink = createDaemonLogSink({
      redact: createLogRedactor(['custom_secret']), // operator extra key honored
      remoteShippers: () => [syslog, otlp],
    });

    sink(rec({ message: SECRET_MSG }));

    // Both remote shippers: redacted, identical, secrets gone.
    for (const s of [syslog, otlp]) {
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].message).toContain('[REDACTED]');
      expect(s.sent[0].message).not.toContain('deadbeef');
      expect(s.sent[0].message).not.toContain('topsecret');
    }
  });

  it('does not redact or persist when no remote shipper is active', () => {
    let redactions = 0;
    const sink = createDaemonLogSink({
      redact: (record) => {
        redactions += 1;
        return record;
      },
      remoteShippers: () => [null, undefined], // exporter:'none' / disabled
    });
    sink(rec({ message: SECRET_MSG }));
    expect(redactions).toBe(0);
  });

  it('skips null shippers but still ships to the active one', () => {
    const otlp = shipper();
    const sink = createDaemonLogSink({
      redact: createLogRedactor(),
      remoteShippers: () => [null, otlp], // syslog off, OTLP on
    });
    sink(rec({ message: SECRET_MSG }));
    expect(otlp.sent).toHaveLength(1);
    expect(otlp.sent[0].message).not.toContain('deadbeef');
  });

  it('redacts once before fanning out to multiple shippers', () => {
    const syslog = shipper();
    const otlp = shipper();
    let redactions = 0;
    const sink = createDaemonLogSink({
      redact: (record) => {
        redactions += 1;
        return createLogRedactor()(record);
      },
      remoteShippers: () => [syslog, otlp],
    });
    sink(rec({ message: SECRET_MSG }));
    expect(redactions).toBe(1);
    expect(syslog.sent).toHaveLength(1);
    expect(otlp.sent).toHaveLength(1);
  });
});
