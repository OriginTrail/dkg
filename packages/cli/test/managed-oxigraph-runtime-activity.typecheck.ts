import type { ManagedOxigraphRuntimeHooksV1 } from '@origintrail-official/dkg-storage';

const leaseHooks: ManagedOxigraphRuntimeHooksV1 = {
  registerActivity: () => ({ report(busy: boolean) { void busy; }, dispose() {} }),
};
const obsoleteHooks: ManagedOxigraphRuntimeHooksV1 = {
  // @ts-expect-error Activity is supplied only through a per-store lease.
  onBusyChange: (_busy: boolean) => {},
};
void leaseHooks;
void obsoleteHooks;
