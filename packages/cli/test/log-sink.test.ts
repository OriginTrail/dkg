import { describe, it, expect } from 'vitest';
import { createLogRedactor, type LogRecord } from '@origintrail-official/dkg-core';
import { createDaemonLogSink, type RemoteLogShipper } from '../src/daemon/log-sink.js';

/**
 * The daemon log sink is the trust boundary where the selected remote shipper gets
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

describe('daemon log sink — diagnostics plus selected remote exporter', () => {
  it('ships one REDACTED copy to the selected shipper', () => {
    const otlp = shipper();
    const sink = createDaemonLogSink({
      insertDiagnosticLog: () => {},
      redact: createLogRedactor(['custom_secret']), // operator extra key honored
      remoteShipper: () => otlp,
    });

    sink(rec({ message: SECRET_MSG }));

    expect(otlp.sent).toHaveLength(1);
    expect(otlp.sent[0].message).toContain('[REDACTED]');
    expect(otlp.sent[0].message).not.toContain('deadbeef');
    expect(otlp.sent[0].message).not.toContain('topsecret');
  });

  it('does not persist routine logs or redact when no remote shipper is active', () => {
    let redactions = 0;
    const diagnostics: unknown[] = [];
    const sink = createDaemonLogSink({
      insertDiagnosticLog: (record) => diagnostics.push(record),
      redact: (record) => {
        redactions += 1;
        return record;
      },
      remoteShipper: () => null, // exporter:'none' / disabled
    });
    sink(rec({ message: SECRET_MSG }));
    expect(redactions).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it('persists full-fidelity warning and error diagnostics with operation context', () => {
    const diagnostics: unknown[] = [];
    const sink = createDaemonLogSink({
      insertDiagnosticLog: (record) => diagnostics.push(record),
      redact: createLogRedactor(),
      remoteShipper: () => null,
      now: () => 1234,
    });

    sink(rec({ level: 'warn', message: 'warning' }));
    sink(rec({ level: 'error', operationId: 'op-2', message: SECRET_MSG }));

    expect(diagnostics).toEqual([
      {
        ts: 1234,
        level: 'warn',
        operation_name: 'publish',
        operation_id: 'op-1',
        module: 'test',
        message: 'warning',
      },
      {
        ts: 1234,
        level: 'error',
        operation_name: 'publish',
        operation_id: 'op-2',
        module: 'test',
        message: SECRET_MSG,
      },
    ]);
  });

  it('tracks runtime disable and exporter selection without rewiring', () => {
    const syslog = shipper();
    const otlp = shipper();
    let active: RemoteLogShipper | null = null;
    const sink = createDaemonLogSink({
      insertDiagnosticLog: () => {},
      redact: createLogRedactor(),
      remoteShipper: () => active,
    });

    sink(rec({ message: SECRET_MSG }));
    active = syslog;
    sink(rec({ message: SECRET_MSG }));
    active = otlp;
    sink(rec({ message: SECRET_MSG }));

    expect(syslog.sent).toHaveLength(1);
    expect(otlp.sent).toHaveLength(1);
    expect(syslog.sent[0].message).not.toContain('deadbeef');
    expect(otlp.sent[0].message).not.toContain('deadbeef');
  });

  it('still exports a diagnostic when local persistence throws', () => {
    const otlp = shipper();
    const sink = createDaemonLogSink({
      insertDiagnosticLog: () => { throw new Error('database locked'); },
      redact: createLogRedactor(),
      remoteShipper: () => otlp,
    });

    expect(() => sink(rec({ level: 'error', message: SECRET_MSG }))).not.toThrow();
    expect(otlp.sent).toHaveLength(1);
    expect(otlp.sent[0].message).not.toContain('deadbeef');
  });
});
