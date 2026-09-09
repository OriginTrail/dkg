import { ProtocolOutbox, type ProtocolOutboxStore, type BoundedProtocolOutboxStore,
  type ProtocolOutboxEntry } from '@origintrail-official/dkg-core';

declare const inspectionStore: ProtocolOutboxStore;
declare const boundedStore: BoundedProtocolOutboxStore;
const inspection = new ProtocolOutbox(inspectionStore);
const legacyPayloads: ProtocolOutboxEntry[] = inspection.duePage(Date.now());
void legacyPayloads;
// @ts-expect-error Bounded operations cannot be invoked through an inspection-only store.
inspection.readDuePage(Date.now(), { maxEntries: 1, maxPayloadBytes: 1024 });
new ProtocolOutbox(boundedStore).readDuePage(Date.now(), { maxEntries: 1, maxPayloadBytes: 1024 });
