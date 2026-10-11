import { VmRecoveryPassAuthority } from '../src/vm-recovery-pass-authority.js';
import type { VmRecoveryTransportPlanningPorts } from '../src/vm-recovery-transport-plan.js';

const authority = new VmRecoveryPassAuthority(undefined, undefined,
  { kind: 'spaced', minIntervalMs: 5_000 });
authority.retryDue();
// @ts-expect-error The pass owns its retry policy; callers cannot override spacing.
authority.retryDue(0);


const ports: VmRecoveryTransportPlanningPorts = {
  resolvePublicAccess: async () => true,
  createSizingReader: () => null,
  // @ts-expect-error Hints enter only through the scoped preparation owner.
  preparedHints: { take: async () => undefined },
};
void ports;
