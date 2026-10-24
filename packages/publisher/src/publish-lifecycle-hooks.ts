import type { PublishLifecycleHooks } from './publisher.js';

/**
 * r10 (3877910013) — THE one extraction of the transaction-lifecycle hooks from an options
 * bag. Every boundary that forwards hooks uses this instead of naming fields by hand, so a
 * future hook is added HERE (and to the type) once, not to several manually synchronized
 * lists — the drop-a-hook regression class (#2270 PR-3 r3) gets one owner. Exported with the
 * contract it implements: consumers forwarding {@link PublishLifecycleHooks} across their own
 * boundaries (the agent's queued execution) use the same picker.
 */
/**
 * r11 (3877968250) — the picker's return type requires EVERY key of the contract to be present
 * (values may be undefined), so adding a hook to {@link PublishLifecycleHooks} without adding
 * it here fails compilation instead of silently dropping the new hook at every boundary.
 */
type CompletePublishLifecycleHooks = {
  [K in keyof Required<PublishLifecycleHooks>]: PublishLifecycleHooks[K];
};

export function pickPublishLifecycleHooks(
  source: PublishLifecycleHooks,
): CompletePublishLifecycleHooks {
  return {
    onPhase: source.onPhase,
    onBeforeBroadcast: source.onBeforeBroadcast,
    onBroadcastAccepted: source.onBroadcastAccepted,
    onPublishConfirmed: source.onPublishConfirmed,
  };
}
