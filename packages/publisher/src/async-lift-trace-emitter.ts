import { createHash } from 'node:crypto';

export interface TraceSink {
  enabled(): boolean;
  write(line: string): void;
}

export interface TraceClockSnapshot {
  readonly monotonicMs: number;
  readonly wallTimeMs: number;
  readonly hrtimeNs?: string;
}

export type TraceFields = Readonly<Record<string, string | number | boolean | undefined>>;

export function isTraceEnabled(source: Pick<TraceSink, 'enabled'>): boolean {
  try { return source.enabled(); } catch { return false; }
}

/** One fail-open emission boundary; event owners retain sequencing and duration semantics. */
export function emitTrace(
  source: TraceSink,
  prefix: string,
  event: string,
  sampleClocks: () => TraceClockSnapshot,
  fields: (monotonicMs: number) => TraceFields,
  walletId?: string,
  claimToken?: string,
): number | undefined {
  try {
    if (!isTraceEnabled(source)) return undefined;
    // Each stream owns its clock requirements and sampling order inside this fail-open boundary.
    const { monotonicMs, wallTimeMs, hrtimeNs } = sampleClocks();
    source.write(`${prefix}${JSON.stringify({
      schemaVersion: 1, processId: process.pid, event, wallTimeMs, monotonicMs, hrtimeNs,
      ...fields(monotonicMs),
      ...(walletId === undefined ? {} : { walletHash: hash(walletId) }),
      ...(claimToken === undefined ? {} : { claimEpochHash: hash(claimToken) }),
    })}`);
    return monotonicMs;
  } catch { return undefined; }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
