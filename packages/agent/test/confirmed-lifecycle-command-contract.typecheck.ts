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
const workerInput: ConfirmedNamedKaVmLifecycleInput = entry.retention === 'historical-unbound' ? confirmed : entry.input;
const workerPackedId: bigint | undefined = entry.input.packedKaId;
// @ts-expect-error The disk encoding cannot enter scheduling or execution.
const wireEntry: LifecycleRepairEntry = { input: stored, attempts: 0, nextAttemptAt: 0 };
void workerInput; void workerPackedId; void wireEntry;

// Newly admitted commands always bind their original chain deployment.
declare const confirmedCommand: import('../src/named-ka-vm-lifecycle-repair.js').ConfirmedNamedKaVmLifecycleInput;
const { publicationDeployment: originalDeployment, ...unboundCommand } = confirmedCommand;
// @ts-expect-error Historical unbound records cannot be submitted as new confirmed commands.
const incompleteCommand: import('../src/named-ka-vm-lifecycle-repair.js').ConfirmedNamedKaVmLifecycleInput = unboundCommand;
void originalDeployment; void incompleteCommand;

import { buildNamedKaVmLifecycleMutation, type NamedKaVmLifecycleProjectionCommand } from '../src/internal/named-ka-vm-lifecycle-mutation.js';
import { applyVerifiedNamedKaDescriptor, type VerifiedNamedKaDescriptorInput } from '../src/named-ka-vm-lifecycle.js';
declare const descriptor: VerifiedNamedKaDescriptorInput;
const workspace = { kind: 'observed' as const, values: {} };
void buildNamedKaVmLifecycleMutation({ ...confirmed, kind: 'confirmed', workspace, preserveVerifiedVmProof: false });
void buildNamedKaVmLifecycleMutation({ ...tentative, kind: 'tentative', workspace, preserveVerifiedVmProof: false });
void buildNamedKaVmLifecycleMutation({ ...descriptor, kind: 'verified-descriptor', workspace: { kind: 'verified' }, preserveVerifiedVmProof: true });
// @ts-expect-error Confirmed projection requires a version even after crossing the internal boundary.
const noVersion: NamedKaVmLifecycleProjectionCommand = { ...descriptor, kind: 'confirmed', workspace, preserveVerifiedVmProof: false };
// @ts-expect-error Tentative commands cannot select the verified descriptor policy through a variable.
void applyVerifiedNamedKaDescriptor(store, tentative);
// @ts-expect-error A confirmed command must use its workspace guard, not descriptor admission.
void buildNamedKaVmLifecycleMutation({ ...confirmed, kind: 'confirmed', workspace: { kind: 'verified' }, preserveVerifiedVmProof: false });
// @ts-expect-error Workspace policy is explicit; omission cannot silently select descriptor behavior.
void buildNamedKaVmLifecycleMutation({ ...descriptor, kind: 'verified-descriptor', preserveVerifiedVmProof: false });
// @ts-expect-error Proof preservation cannot be supplied as a second independent channel.
void buildNamedKaVmLifecycleMutation({ ...confirmed, kind: 'confirmed', workspace, preserveVerifiedVmProof: true }, {}, false);
void noVersion;

import type { ConfirmedNamedKaVmLifecycleAdmission } from '../src/named-ka-vm-lifecycle-executor.js';
const admitted = { lifecycleAuthor: confirmed.agentAddress, preserveVerifiedVmProof: false };
// @ts-expect-error Admission resolves author/policy; it cannot replace checked publication evidence.
const replacedPublication: ConfirmedNamedKaVmLifecycleAdmission = { ...admitted, input: confirmed };
// @ts-expect-error Admission cannot change the checked root independently.
const replacedRoot: ConfirmedNamedKaVmLifecycleAdmission = { ...admitted, merkleRoot: '00' };
void replacedPublication; void replacedRoot;

const { packedKaId: resolvedIdentity, ...withoutIdentity } = confirmed;
// @ts-expect-error Newly executable confirmed commands require the resolved KA identity.
const missingIdentity: ConfirmedNamedKaVmLifecycleInput = withoutIdentity;
// @ts-expect-error Receipts cannot supply a fallback for missing caller-resolved coordinates.
void confirmedNamedKaVmLifecycleInput(publication, withoutIdentity);
void resolvedIdentity; void missingIdentity;
