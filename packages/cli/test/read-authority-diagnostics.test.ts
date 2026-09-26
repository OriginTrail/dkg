import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';
import { createReadAuthorityDiagnostics } from '../src/daemon/read-authority-diagnostics.js';

interface Line {
  readonly level: 'info' | 'warn';
  readonly operationId: string;
  readonly message: string;
}

function harness(options: { cacheMax?: number } = {}) {
  const lines: Line[] = [];
  let clock = 0;
  const diagnostics = createReadAuthorityDiagnostics({
    logger: {
      info: (ctx: OperationContext, message: string) => { lines.push({ level: 'info', operationId: ctx.operationId, message }); },
      warn: (ctx: OperationContext, message: string) => { lines.push({ level: 'warn', operationId: ctx.operationId, message }); },
    },
    now: () => clock,
    intervalMs: 60_000,
    ...options,
  });
  return { lines, diagnostics, advance: (ms: number) => { clock += ms; } };
}

const STORE = { source: 'registered-chain', reason: 'local-existence-unavailable', dependency: 'store' };

describe('read-authority 503 diagnostics (#2834)', () => {
  it('logs every 503 under its own operation id: a warning per attribution and window, info lines in between', () => {
    const { lines, diagnostics, advance } = harness();
    const ids = [0, 1, 2].map(() => createOperationContext('query'));

    diagnostics.record(ids[0]!, STORE);
    advance(10_000);
    diagnostics.record(ids[1]!, STORE);
    advance(51_000);
    diagnostics.record(ids[2]!, STORE);

    expect(lines.map((line) => [line.level, line.operationId])).toEqual([
      ['warn', ids[0]!.operationId],
      ['info', ids[1]!.operationId],
      ['warn', ids[2]!.operationId],
    ]);
    expect(lines.every((line) => line.message.includes(
      'source=registered-chain reason=local-existence-unavailable dependency=store',
    ))).toBe(true);
    expect(lines[2]!.message).toContain('dependency=store (1 more since the last warning)');
  });

  it('warns separately for each attribution', () => {
    const { lines, diagnostics } = harness();

    diagnostics.record(createOperationContext('query'), STORE);
    diagnostics.record(createOperationContext('query'), { ...STORE, reason: 'chain-access-policy-timeout', dependency: 'chain' });

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn']);
    expect(lines[1]!.message).toContain('reason=chain-access-policy-timeout dependency=chain');
  });

  it('remembers a bounded number of attributions, oldest out first', () => {
    const { lines, diagnostics } = harness({ cacheMax: 2 });
    const attribution = (reason: string) => ({ ...STORE, reason });

    diagnostics.record(createOperationContext('query'), attribution('reason-a'));
    diagnostics.record(createOperationContext('query'), attribution('reason-b'));
    diagnostics.record(createOperationContext('query'), attribution('reason-c'));
    diagnostics.record(createOperationContext('query'), attribution('reason-a'));

    // reason-a was evicted by reason-c, so it warns again inside its window.
    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn', 'warn', 'warn']);
  });

  it('starts a new window when the clock steps back', () => {
    const { lines, diagnostics, advance } = harness();

    diagnostics.record(createOperationContext('query'), STORE);
    advance(-30_000);
    diagnostics.record(createOperationContext('query'), STORE);

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn']);
  });

  it('logs anything but an attribution token as unknown', () => {
    const { lines, diagnostics } = harness();

    diagnostics.record(createOperationContext('query'), {
      source: 'registered-chain',
      reason: 'RPC https://user:secret@rpc.example.invalid failed',
      dependency: { raw: true },
    });

    expect(lines[0]!.message).toContain('source=registered-chain reason=unknown dependency=unknown');
    expect(lines[0]!.message).not.toContain('secret');
  });
});
