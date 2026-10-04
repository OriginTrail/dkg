import type { TripleStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair, type ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
import type { LifecycleRepairEntry, StoredLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { applyPublishedNamedKaVmLifecycle, applyTentativeNamedKaVmLifecycle, type TentativeNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle.js';
declare const confirmed: ConfirmedNamedKaVmLifecycleInput;
declare const stored: StoredLifecycleRepairInput;
declare const store: TripleStore;
// @ts-expect-error Confirmed repair evidence cannot select tentative consumption or omit durability.
const ambiguous: ConfirmedNamedKaVmLifecycleInput = { ...confirmed, tentative: true };
// @ts-expect-error Persisted confirmed evidence cannot contain a tentative flag.
const ambiguousJournal: StoredLifecycleRepairInput = { ...stored, tentative: false };
// @ts-expect-error The confirmed entry point refuses tentative commands.
void applyPublishedNamedKaVmLifecycle(store, { ...confirmed, tentative: true });
// @ts-expect-error Every repair owner must share the publisher lifecycle lock domain.
new NamedKaVmLifecycleRepair({ apply: async () => {}, isCurrent: async () => true, warn: () => {} });
void ambiguous; void ambiguousJournal;

declare const tentative: TentativeNamedKaVmLifecycleInput;
void applyTentativeNamedKaVmLifecycle(store, tentative);
// @ts-expect-error A tentative command cannot be admitted as confirmed evidence, even through a variable.
const mistakenRepair: ConfirmedNamedKaVmLifecycleInput = { ...tentative, assertionVersion: '1' };
// @ts-expect-error The tentative entry point requires an explicit tentative command.
void applyTentativeNamedKaVmLifecycle(store, confirmed);
void mistakenRepair;

// @ts-expect-error Tentative commands cannot claim confirmed VM graph coordinates.
void applyTentativeNamedKaVmLifecycle(store, { ...tentative, packedKaId: 1n });
// @ts-expect-error A confirmed command's coordinates remain forbidden through a variable.
const graphClaim: TentativeNamedKaVmLifecycleInput = { ...confirmed, tentative: true };
void graphClaim;

import { confirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import type { ConfirmedNamedKaVmPublication } from '../src/named-ka-vm-lifecycle-recovery-error.js';
declare const publication: ConfirmedNamedKaVmPublication;
// @ts-expect-error Root evidence is owned by the validated publication, not coordinates.
void confirmedNamedKaVmLifecycleInput(publication, { contextGraphId: 'cg', name: 'ka', agentAddress: 'agent', merkleRoot: '00' });
// @ts-expect-error Version evidence is owned by the validated publication, not coordinates.
void confirmedNamedKaVmLifecycleInput(publication, { contextGraphId: 'cg', name: 'ka', agentAddress: 'agent', assertionVersion: '999' });

declare const entry: LifecycleRepairEntry;
const workerInput: ConfirmedNamedKaVmLifecycleInput = entry.input;
const workerPackedId: bigint | undefined = entry.input.packedKaId;
// @ts-expect-error The disk encoding cannot enter scheduling or execution.
const wireEntry: LifecycleRepairEntry = { input: stored, attempts: 0, nextAttemptAt: 0 };
void workerInput; void workerPackedId; void wireEntry;
