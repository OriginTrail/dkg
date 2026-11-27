/** Internal sweep capability; deliberately absent from the package-root API. */
export interface VmReconcileSweepAdmission<T = unknown> {
  readonly tryAdmit: (key: string) => Promise<T> | undefined;
  /** Dispatcher-owned timer cap; coalesced work does not consume another slot. */
  readonly tryAdmitBoundTimer: (key: string) => Promise<T> | undefined;
  readonly waitForChange: (signal?: AbortSignal) => Promise<void>;
  readonly isClosed: () => boolean;
  /** Keep waiting periodic admission visible until its owner retires. */
  readonly retainCapacity: (signal: AbortSignal) => () => void;
}
