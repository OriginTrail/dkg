import { validatePromoteRecoveryBinding, type PublisherAssertionPromoteOptions } from '@origintrail-official/dkg-publisher';
import type { PreSignedAuthorAttestation } from '../../dkg-agent-types.js';

type Binding = NonNullable<PublisherAssertionPromoteOptions['recoveryBinding']>;
interface PromoteAttemptOptions {
  subGraphName?: string;
  agentAddress?: string;
  authorAgentAddress?: string;
  awaitCuratorAck?: boolean;
  curatorAckTimeoutMs?: number;
}
export interface OrdinaryAssertionPromoteOptions extends PromoteAttemptOptions, Pick<PublisherAssertionPromoteOptions,
  'entities' | 'accessPolicy' | 'allowedPeers'> {
  recoveryBinding?: never;
  preSignedAuthorAttestation?: PreSignedAuthorAttestation;
  skipSeal?: boolean;
}
export interface BoundAssertionPromoteOptions extends PromoteAttemptOptions {
  recoveryBinding: Binding;
  entities?: 'all';
  skipSeal?: never;
  preSignedAuthorAttestation?: never;
  accessPolicy?: never;
  allowedPeers?: never;
}
export type AssertionPromoteOptions = OrdinaryAssertionPromoteOptions | BoundAssertionPromoteOptions;
export type AssertionPromoteExecution =
  | { kind: 'ordinary'; options: OrdinaryAssertionPromoteOptions }
  | { kind: 'bound'; binding: Binding; options: OrdinaryAssertionPromoteOptions };

/** Normalize once: bound policy comes exclusively from its validated immutable intent. */
export function normalizeAssertionPromoteExecution(input?: AssertionPromoteOptions): AssertionPromoteExecution {
  if (!input?.recoveryBinding) return { kind: 'ordinary', options: input ?? {} };
  // Keep the runtime check for untyped callers despite the narrower TypeScript contract.
  if (input.skipSeal || (input.entities && input.entities !== 'all')) {
    throw new Error('Bound recovery requires a sealed, complete Knowledge Asset');
  }
  const binding = validatePromoteRecoveryBinding(input.recoveryBinding);
  return { kind: 'bound', binding, options: {
    agentAddress: input.agentAddress, authorAgentAddress: input.authorAgentAddress, subGraphName: input.subGraphName,
    entities: 'all', curatorAckTimeoutMs: input.curatorAckTimeoutMs,
    awaitCuratorAck: binding.intent.confirmationRequired || input.awaitCuratorAck === true,
    accessPolicy: binding.intent.accessPolicy, allowedPeers: [...binding.intent.allowedPeers],
  } };
}
