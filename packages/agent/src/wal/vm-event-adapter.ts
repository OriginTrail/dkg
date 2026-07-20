import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ProtocolTuple } from '@origintrail-official/dkg-wal';
import {
  assertMoveTierPublicDisclosureSafeV1,
  effectiveVmFinalityBlocksV1,
  verifyMoveTierOpeningV1,
  verifyTierTransitionReceiptBindingV1,
  vmBytesEqualV1,
  type CurrentVmFinalityPolicyV1,
} from '@origintrail-official/dkg-wal/vm';
import {
  dkgSemanticCore,
  type DkgSemanticCore,
  type DkgSemanticDriver,
} from '../semantic/dkg-semantic-core.js';
import type { DkgVmChainValidationResultV1 } from '../semantic/vm-chain-validator.js';
import type {
  DkgWalProjectionApplyResultV1,
  DkgWalProjectionMaterializerV1,
  DkgWalSemanticProjectionOutcomeV1,
} from './projection-materializer.js';

type VmDriver = Extract<
  DkgSemanticDriver,
  'legacy-sync' | 'wal-sync' | 'chain-event'
>;

export type DkgWalVmEventTriggerV1 =
  | 'wal-replay'
  | 'chain-recheck'
  | 'policy-reconfiguration'
  | 'restart-revalidation';

export interface DkgVmSemanticEvidenceV1 {
  readonly trigger: DkgWalVmEventTriggerV1;
  readonly sourceNamespaceId: Uint8Array;
  readonly sourceWalObjectId: Uint8Array;
  readonly targetNamespaceId: Uint8Array;
  readonly targetWalObjectId: Uint8Array;
  readonly source: ProtocolTuple<'MoveTierSourceV1'>;
  readonly target: ProtocolTuple<'MoveTierTargetV1'>;
  readonly receipt: ProtocolTuple<'TierTransitionReceiptV1'>;
  readonly finalityPolicy: CurrentVmFinalityPolicyV1;
  readonly chainValidation: DkgVmChainValidationResultV1;
}

export interface CurrentDkgVmSemanticImplementationV1 {
  /**
   * The existing DKG/SWM/VM semantic implementation. It returns a complete
   * shadow projection; this adapter does not inspect or alter that outcome.
   */
  applyVmEvidence(
    input: DkgVmSemanticEvidenceV1,
  ): Promise<DkgWalSemanticProjectionOutcomeV1>;
}

export interface DkgWalVmEventInputV1 {
  readonly trigger: DkgWalVmEventTriggerV1;
  readonly sourceNamespaceId: Uint8Array;
  readonly sourceWalObjectId: Uint8Array;
  readonly targetNamespaceId: Uint8Array;
  readonly targetWalObjectId: Uint8Array;
  readonly source: ProtocolTuple<'MoveTierSourceV1'>;
  readonly target: ProtocolTuple<'MoveTierTargetV1'>;
  readonly receipt: ProtocolTuple<'TierTransitionReceiptV1'>;
  readonly currentCuratorVectorId: Uint8Array;
  /** Additional source-only representations such as graph names and epochs. */
  readonly privateSourceValues?: readonly Uint8Array[];
}

export interface DkgWalVmEventAdapterOptionsV1 {
  readonly chain: ChainAdapter;
  readonly semanticImplementation: CurrentDkgVmSemanticImplementationV1;
  readonly materializer: Pick<DkgWalProjectionMaterializerV1, 'apply'>;
  readonly semanticCore?: DkgSemanticCore;
  readonly isWalObjectAdmitted: (objectId: Uint8Array) => boolean | Promise<boolean>;
  readonly authorizeSourceView: (input: {
    readonly namespaceId: Uint8Array;
    readonly objectId: Uint8Array;
  }) => boolean | Promise<boolean>;
  readonly verifyTierReceiptAuthority: (
    receipt: ProtocolTuple<'TierTransitionReceiptV1'>,
    atMs: number,
  ) => void | Promise<void>;
  readonly resolveCurrentFinalityPolicy: (input: {
    readonly policyObjectId: Uint8Array;
    readonly chainId: bigint;
  }) => CurrentVmFinalityPolicyV1 | Promise<CurrentVmFinalityPolicyV1>;
  readonly now?: () => number;
}

export type DkgWalVmEventAdapterErrorCodeV1 =
  | 'WAL_VM_OBJECT_NOT_ADMITTED'
  | 'WAL_VM_SOURCE_UNAUTHORIZED'
  | 'WAL_VM_POLICY_MISMATCH';

export class DkgWalVmEventAdapterErrorV1 extends Error {
  constructor(readonly code: DkgWalVmEventAdapterErrorCodeV1, message: string) {
    super(message);
    this.name = 'DkgWalVmEventAdapterErrorV1';
  }
}

export interface DkgWalVmEventResultV1 {
  readonly chainValidation: DkgVmChainValidationResultV1;
  readonly materialization: DkgWalProjectionApplyResultV1;
}

function fixed32(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(label + ' must be exactly 32 bytes');
  }
  return new Uint8Array(value);
}

/**
 * Driver-independent bridge used by both synchronization mechanisms. It owns
 * no VM state and delegates the full event to the existing semantic owner.
 */
export class CurrentDkgVmSemanticCoreAdapterV1 {
  private readonly semanticCore: DkgSemanticCore;

  constructor(
    private readonly implementation: CurrentDkgVmSemanticImplementationV1,
    semanticCore: DkgSemanticCore = dkgSemanticCore,
  ) {
    this.semanticCore = semanticCore;
  }

  apply(
    driver: VmDriver,
    input: DkgVmSemanticEvidenceV1,
  ): Promise<DkgWalSemanticProjectionOutcomeV1> {
    return this.semanticCore.invokeVmSemanticEntryPoint(
      driver,
      () => this.implementation.applyVmEvidence(input),
    );
  }
}

/**
 * WAL-side VM event orchestrator. Protocol binding and privacy are checked
 * before current chain validation. Every VM/SWM decision is then made by the
 * existing semantic implementation and persisted only by WAL-015.
 */
export class DkgWalVmEventAdapterV1 {
  private readonly semanticCore: DkgSemanticCore;
  private readonly semanticBridge: CurrentDkgVmSemanticCoreAdapterV1;
  private readonly now: () => number;

  constructor(private readonly options: DkgWalVmEventAdapterOptionsV1) {
    this.semanticCore = options.semanticCore ?? dkgSemanticCore;
    this.semanticBridge = new CurrentDkgVmSemanticCoreAdapterV1(
      options.semanticImplementation,
      this.semanticCore,
    );
    this.now = options.now ?? Date.now;
  }

  async apply(input: DkgWalVmEventInputV1): Promise<DkgWalVmEventResultV1> {
    const sourceNamespaceId = fixed32(input.sourceNamespaceId, 'sourceNamespaceId');
    const sourceWalObjectId = fixed32(input.sourceWalObjectId, 'sourceWalObjectId');
    const targetNamespaceId = fixed32(input.targetNamespaceId, 'targetNamespaceId');
    const targetWalObjectId = fixed32(input.targetWalObjectId, 'targetWalObjectId');
    const currentCuratorVectorId = fixed32(
      input.currentCuratorVectorId,
      'currentCuratorVectorId',
    );
    const [sourceAdmitted, targetAdmitted] = await Promise.all([
      this.options.isWalObjectAdmitted(sourceWalObjectId),
      this.options.isWalObjectAdmitted(targetWalObjectId),
    ]);
    if (!sourceAdmitted || !targetAdmitted) {
      throw new DkgWalVmEventAdapterErrorV1(
        'WAL_VM_OBJECT_NOT_ADMITTED',
        'both complete source and target WalObjects must be durably admitted',
      );
    }
    if (!await this.options.authorizeSourceView({
      namespaceId: sourceNamespaceId,
      objectId: sourceWalObjectId,
    })) {
      throw new DkgWalVmEventAdapterErrorV1(
        'WAL_VM_SOURCE_UNAUTHORIZED',
        'current DKG membership denied the private source view',
      );
    }

    const opening = verifyMoveTierOpeningV1({
      sourceNamespaceId,
      targetNamespaceId,
      targetWalObjectId,
      source: input.source,
      target: input.target,
    });
    const evaluatedAtMs = this.now();
    verifyTierTransitionReceiptBindingV1({
      targetNamespaceId,
      targetWalObjectId,
      target: input.target,
      receipt: input.receipt,
      expectedCuratorVectorId: currentCuratorVectorId,
      nowMs: evaluatedAtMs,
    });
    await this.options.verifyTierReceiptAuthority(input.receipt, evaluatedAtMs);

    assertMoveTierPublicDisclosureSafeV1({
      target: input.target,
      privateValues: [
        sourceNamespaceId,
        sourceWalObjectId,
        input.source[1],
        ...input.source[5],
        input.source[6],
        input.source[7],
        ...(input.privateSourceValues ?? []),
      ],
    });
    const finalityPolicy = await this.options.resolveCurrentFinalityPolicy({
      policyObjectId: input.receipt[4],
      chainId: opening.chainBinding[0],
    });
    if (!vmBytesEqualV1(finalityPolicy.policyObjectId, input.receipt[4])) {
      throw new DkgWalVmEventAdapterErrorV1(
        'WAL_VM_POLICY_MISMATCH',
        'resolved finality policy does not match the tier receipt',
      );
    }
    effectiveVmFinalityBlocksV1(opening.chainBinding, finalityPolicy);
    const chainValidation = await this.semanticCore.validateVmChainEvidence(
      'wal-sync',
      {
        chain: this.options.chain,
        binding: opening.chainBinding,
        finalityPolicy,
      },
    );
    const outcome = await this.semanticBridge.apply('wal-sync', {
      trigger: input.trigger,
      sourceNamespaceId,
      sourceWalObjectId,
      targetNamespaceId,
      targetWalObjectId,
      source: input.source,
      target: input.target,
      receipt: input.receipt,
      finalityPolicy,
      chainValidation,
    });
    const materialization = await this.options.materializer.apply(outcome);
    return { chainValidation, materialization };
  }
}
