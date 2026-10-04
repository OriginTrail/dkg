import type { TripleStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair, type ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
import type { StoredLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
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
