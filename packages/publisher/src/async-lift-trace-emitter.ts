import { createHash } from 'node:crypto';

export interface TraceSources {
  enabled(): boolean;
  clock(): number;
  monotonicNs?(): bigint;
  wallClock(): number;
  write(line: string): void;
}

export type TraceFields = Readonly<Record<string, string | number | boolean | undefined>>;

export function isTraceEnabled(source: Pick<TraceSources, 'enabled'>): boolean {
  try { return source.enabled(); } catch { return false; }
}

/** One fail-open emission boundary; event owners retain sequencing and duration semantics. */
export function emitTrace(
  source: TraceSources,
  prefix: string,
  clockOrder: 'wall-first' | 'native-first',
  event: string,
  fields: (monotonicMs: number) => TraceFields,
  walletId?: string,
  claimToken?: string,
): number | undefined {
  try {
    if (!isTraceEnabled(source)) return undefined;
    const monotonicMs = source.clock();
    // Preserve each existing stream's sampling order, including optional native-clock omission.
    let wallTimeMs: number;
    let hrtimeNs: string | undefined;
    if (clockOrder === 'wall-first') {
      wallTimeMs = source.wallClock();
      hrtimeNs = source.monotonicNs?.().toString();
    } else {
      hrtimeNs = source.monotonicNs!().toString();
      wallTimeMs = source.wallClock();
    }
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
