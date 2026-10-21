import type { PromoteExecutionAuthority } from '@origintrail-official/dkg-publisher';

/** Caller holds the assertion lifecycle fence throughout this crash-safe sequence. */
export async function commitAssertionFinalization(steps: {
  authority?: PromoteExecutionAuthority;
  materialize: () => Promise<string>;
  writePrivateContent: () => Promise<unknown>;
  persistFreshSeal?: () => Promise<unknown>;
  stampLifecycle: () => Promise<unknown>;
  cleanupSources: (canonicalGraph: string) => Promise<unknown>;
  cleanupPrivateDraft: () => Promise<unknown>;
}): Promise<void> {
  const guarded = async <T>(write: () => Promise<T>): Promise<T> => {
    await steps.authority?.assertCurrent();
    return write();
  };
  // Preserve the original source until canonical content, seal and pointers are durable.
  const canonicalGraph = await guarded(steps.materialize);
  await guarded(steps.writePrivateContent);
  if (steps.persistFreshSeal) await guarded(steps.persistFreshSeal);
  // The lifecycle callback also checks authority between its individual writes.
  await guarded(steps.stampLifecycle);
  await guarded(() => steps.cleanupSources(canonicalGraph));
  await guarded(steps.cleanupPrivateDraft);
}
