export interface GraphScopedPhysicalOperationControl<Subscription> {
  readonly subscription: Subscription;
  /** True only while the subscription identity and binding generation match. */
  isBindingCurrent(): boolean;
  /** Re-capture after this operation installs an authenticated binding. */
  recaptureBindingGeneration(): void;
  /** Enforce cancellation, lifecycle, shutdown, and binding ownership. */
  assertCurrent(): void;
}

export interface GraphScopedPhysicalOperationFenceOptions<T, Subscription> {
  readonly contextGraphId: string;
  readonly signal?: AbortSignal;
  isClosed(): boolean;
  captureSubscription(): Subscription;
  captureBindingGeneration(): number;
  isBindingGenerationCurrent(generation: number): boolean;
  assertLifecycleCurrent(): void;
  closedError(): Error;
  bindingChangedError(): Error;
  asAbortError(reason: unknown): Error;
  track(run: Promise<unknown>): void;
  untrack(run: Promise<unknown>): void;
  operation(control: GraphScopedPhysicalOperationControl<Subscription>): Promise<T>;
}

/**
 * Own the lifecycle boundary shared by graph-scoped authentication and
 * materialization. The operation callback contains only feature-specific work;
 * shutdown, rebinding, cancellation, and in-flight run tracking stay uniform.
 */
export function runGraphScopedPhysicalOperation<T, Subscription>(
  options: GraphScopedPhysicalOperationFenceOptions<T, Subscription>,
): Promise<T> {
  if (options.isClosed()) return Promise.reject(options.closedError());

  const subscription = options.captureSubscription();
  let bindingGeneration = options.captureBindingGeneration();
  const isBindingCurrent = () => (
    options.captureSubscription() === subscription
    && options.isBindingGenerationCurrent(bindingGeneration)
  );
  const assertCurrent = () => {
    if (options.signal?.aborted) {
      throw options.asAbortError(options.signal.reason);
    }
    options.assertLifecycleCurrent();
    if (options.isClosed()) throw options.closedError();
    if (!isBindingCurrent()) throw options.bindingChangedError();
  };
  const physicalRun = Promise.resolve().then(() => options.operation({
    subscription,
    isBindingCurrent,
    recaptureBindingGeneration: () => {
      bindingGeneration = options.captureBindingGeneration();
    },
    assertCurrent,
  }));
  options.track(physicalRun);
  return physicalRun.finally(() => options.untrack(physicalRun));
}
