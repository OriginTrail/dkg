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

export interface GraphScopedPhysicalOperationFenceHost<Subscription> {
  isClosed(): boolean;
  captureSubscription(contextGraphId: string): Subscription;
  captureBindingGeneration(contextGraphId: string): number;
  isBindingGenerationCurrent(contextGraphId: string, generation: number): boolean;
  assertLifecycleCurrent(): void;
  asAbortError(reason: unknown): Error;
  track(run: Promise<unknown>): void;
  untrack(run: Promise<unknown>): void;
}

export interface BoundGraphScopedPhysicalOperationOptions<T, Subscription> {
  readonly contextGraphId: string;
  readonly signal?: AbortSignal;
  closedError(): Error;
  bindingChangedError(): Error;
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

/** Capture lifecycle-stable wiring once; individual operations supply only ownership-specific work. */
export function createGraphScopedPhysicalOperationFence<Subscription>(
  host: GraphScopedPhysicalOperationFenceHost<Subscription>,
): <T>(options: BoundGraphScopedPhysicalOperationOptions<T, Subscription>) => Promise<T> {
  return <T>(options: BoundGraphScopedPhysicalOperationOptions<T, Subscription>) => (
    runGraphScopedPhysicalOperation({
      ...options,
      isClosed: host.isClosed,
      captureSubscription: () => host.captureSubscription(options.contextGraphId),
      captureBindingGeneration: () => host.captureBindingGeneration(options.contextGraphId),
      isBindingGenerationCurrent: (generation) =>
        host.isBindingGenerationCurrent(options.contextGraphId, generation),
      assertLifecycleCurrent: host.assertLifecycleCurrent,
      asAbortError: host.asAbortError,
      track: host.track,
      untrack: host.untrack,
    })
  );
}
