/** Internal sweep capability; deliberately absent from the package-root API. */
export interface VmReconcileSweepAdmission<T = unknown> {
  readonly tryAdmit: (key: string) => Promise<T> | undefined;
  /** Timer admission with a cap on outstanding historical bound work. */
  readonly tryAdmitBound: (key: string) => Promise<T> | undefined;
  /** Discovery keeps its own attempt budget and dispatcher queue policy. */
  readonly tryAdmitUnbound: (key: string) => Promise<T> | undefined;
  readonly waitForChange: (signal?: AbortSignal) => Promise<void>;
  readonly isClosed: () => boolean;
  /** Keep waiting periodic admission visible until its owner retires. */
  readonly retainCapacity: (signal: AbortSignal) => () => void;
}
