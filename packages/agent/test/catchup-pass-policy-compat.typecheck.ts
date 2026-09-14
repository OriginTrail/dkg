import { resolveSwmCatchupPassConfig, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import type { ResolvedDKGAgentConfig } from '@origintrail-official/dkg-agent/dist/resolved-agent-config.js';
import type { ResolvedDKGAgentConfig as LegacyResolvedConfig } from '@origintrail-official/dkg-agent/dist/dkg-agent-types.js';

// Named interfaces lack a general string index signature. Both the historical
// package subpath and this public environment contract must remain consumable.
interface CatchupEnv {
  DKG_SWM_CATCHUP_PASS_BUDGET_MS?: string;
  DKG_SWM_CATCHUP_MAX_PASSES?: string;
}
declare const env: CatchupEnv;
resolveSwmCatchupPassConfig(env);
declare const readonlyEnv: Readonly<CatchupEnv>;
resolveSwmCatchupPassConfig(readonlyEnv);
resolveSwmCatchupPassConfig(process.env);
// The historical export is a strict superset of the canonical runtime model.
declare const legacyResolved: LegacyResolvedConfig;
const canonicalResolved: ResolvedDKGAgentConfig = legacyResolved;
void canonicalResolved;

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

// @ts-expect-error Reconciler timing has one resolved owner.
void resolved.syncReconcilerTiming;
void resolved.resourcePolicy.reconcilerTiming;
