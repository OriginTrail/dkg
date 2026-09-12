import { resolveSwmCatchupPassConfig, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import type { ResolvedDKGAgentConfig } from '../src/dkg-agent-types.js';

const pass = resolveSwmCatchupPassConfig({});
pass.maxPasses = 2;
pass.budgetMs = 123;

const publicInput: DKGAgentConfig = { name: 'resource-inputs',
  syncGlobalMaxInflight: 3, syncGlobalLimit: 3, syncGlobalQueueLimit: 6,
  syncAdmission: { mode: 'shared' }, syncResponderSnapshotLimits: { local: { rows: 1 } },
};
declare const resolved: ResolvedDKGAgentConfig;
// @ts-expect-error Runtime consumers must use the resolved policy.
void resolved.syncGlobalMaxInflight;
// @ts-expect-error Runtime consumers must use the resolved policy.
void resolved.syncGlobalLimit;
// @ts-expect-error Runtime consumers must use the resolved policy.
void resolved.syncGlobalQueueLimit;
// @ts-expect-error Runtime consumers must use the resolved policy.
void resolved.syncAdmission;
// @ts-expect-error Runtime consumers must use the resolved policy.
void resolved.syncResponderSnapshotLimits;
void publicInput;
