import type { PublishLifecycleHooks } from './publisher.js';

/**
 * r10 (3877910013) — THE one extraction of the transaction-lifecycle hooks from an options
 * bag. Every boundary that forwards hooks uses this instead of naming fields by hand, so a
 * future hook is added HERE (and to the type) once, not to several manually synchronized
 * lists — the drop-a-hook regression class (#2270 PR-3 r3) gets one owner. Exported with the
 * contract it implements: consumers forwarding {@link PublishLifecycleHooks} across their own
 * boundaries (the agent's queued execution) use the same picker.
 */
export function pickPublishLifecycleHooks(source: PublishLifecycleHooks): PublishLifecycleHooks {
  return {
    onPhase: source.onPhase,
    onBeforeBroadcast: source.onBeforeBroadcast,
    onBroadcastAccepted: source.onBroadcastAccepted,
    onPublishConfirmed: source.onPublishConfirmed,
  };
}
