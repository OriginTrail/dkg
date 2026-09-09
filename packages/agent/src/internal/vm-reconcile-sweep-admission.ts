/** Internal sweep capability; deliberately absent from the package-root API. */
export interface VmReconcileSweepAdmission<T = unknown> {
  readonly tryAdmit: (key: string) => Promise<T> | undefined;
  readonly waitForChange: (signal?: AbortSignal) => Promise<void>;
  readonly isClosed: () => boolean;
}
