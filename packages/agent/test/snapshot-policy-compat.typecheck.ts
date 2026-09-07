import {
  resolveSyncResponderSnapshotPolicy,
  type ResolvedSyncResponderSnapshotPolicy,
} from '@origintrail-official/dkg-agent/dist/sync/responder/sync-handler.js';

const warnings: string[] = [];
const result: ResolvedSyncResponderSnapshotPolicy = resolveSyncResponderSnapshotPolicy(
  { global: { rows: 100 }, local: { rows: 150 } }, {}, (message) => warnings.push(message),
);
const rowsClamped: boolean = result.localRowsClamped;
const bytesClamped: boolean = result.localBytesEstimateClamped;
// The compatibility result remains mutable; diagnostics belong to the internal resolver.
result.localRowsClamped = false;
result.budget.maxRows = 200;
void [rowsClamped, bytesClamped];
