// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ContextGraphAuthorityHistoryResolution } from './context-graph-authority-history.js';
import type {
  ContextGraphAuthorityIndexEvent,
  ContextGraphAuthorityIndexState,
} from './context-graph-authority-index.js';

export const CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES = Object.freeze([
  'ContextGraphCreated',
  'Transfer',
  'PublishPolicyUpdated',
  'PublishAuthorityUpdated',
  'AgentParticipantAdded',
  'AgentParticipantRemoved',
] as const);

export interface EvmContextGraphCurrentAuthorityState {
  readonly owner: string;
  readonly active: boolean;
  readonly accessPolicy: number;
  readonly publishPolicy: number;
  readonly publishAuthority: string | null;
  readonly publishAuthorityAccountId: string;
  readonly participantAgents: readonly string[];
}

export interface EvmContextGraphAuthorityGeneration {
  readonly nameHash: string;
  readonly ownershipEra: number;
  readonly policyVersion: number;
  readonly rosterVersion: number;
  readonly sourceBlockNumber: number;
  readonly sourceBlockHash: string;
}

export interface EvmContextGraphAuthoritySourceResult {
  readonly current: EvmContextGraphCurrentAuthorityState;
  readonly generation: EvmContextGraphAuthorityGeneration;
  /** Final cross-read fence or legacy checkpoint publication. */
  stabilize(): Promise<void>;
}

export type EvmContextGraphAuthoritySource =
  | Readonly<{
      kind: 'indexed';
      readCurrent(): Promise<unknown>;
      readGeneration(): Promise<ContextGraphAuthorityIndexState>;
      stabilize(): Promise<void>;
    }>
  | Readonly<{
      kind: 'legacy';
      readCurrent(): Promise<unknown>;
      readHistory(): Promise<ContextGraphAuthorityHistoryResolution>;
    }>;

function tupleField(value: unknown, name: string, index: number): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const named = (value as Record<string, unknown>)[name];
  if (named !== undefined) return named;
  return Array.isArray(value) ? value[index] : undefined;
}

function normalizePolicy(value: unknown, label: string): number {
  const policy = Number(BigInt(value as ethers.BigNumberish));
  if (!Number.isSafeInteger(policy) || policy < 0) {
    throw new Error(`Context Graph ${label} is invalid`);
  }
  return policy;
}

/** Normalize the ethers named tuple once, at the reader boundary. */
export function normalizeEvmContextGraphCurrentAuthorityState(
  value: unknown,
): EvmContextGraphCurrentAuthorityState {
  const owner = String(tupleField(value, 'owner', 0)).toLowerCase();
  if (!ethers.isAddress(owner)) throw new Error('Context Graph owner is invalid');
  const participantValue = tupleField(value, 'participantAgents', 1);
  if (!Array.isArray(participantValue)) {
    throw new Error('Context Graph participant agents are invalid');
  }
  const participantAgents = participantValue.map((entry) => String(entry).toLowerCase());
  if (participantAgents.some((entry) => !ethers.isAddress(entry))) {
    throw new Error('Context Graph participant agent is invalid');
  }
  participantAgents.sort();
  const authority = String(tupleField(value, 'publishAuthority', 7)).toLowerCase();
  if (!ethers.isAddress(authority)) {
    throw new Error('Context Graph publish authority is invalid');
  }
  const accountId = BigInt(
    tupleField(value, 'publishAuthorityAccountId', 8) as ethers.BigNumberish,
  );
  if (accountId < 0n || accountId > ethers.MaxUint256) {
    throw new Error('Context Graph publish authority account id is invalid');
  }
  return Object.freeze({
    owner,
    active: Boolean(tupleField(value, 'active', 3)),
    accessPolicy: normalizePolicy(tupleField(value, 'accessPolicy', 5), 'access policy'),
    publishPolicy: normalizePolicy(tupleField(value, 'publishPolicy', 6), 'publish policy'),
    publishAuthority: authority === ethers.ZeroAddress ? null : authority,
    publishAuthorityAccountId: accountId.toString(10),
    participantAgents: Object.freeze(participantAgents),
  });
}

/** Resolve either authority source into one typed model for snapshot assembly. */
export async function resolveEvmContextGraphAuthoritySource(
  source: EvmContextGraphAuthoritySource,
): Promise<EvmContextGraphAuthoritySourceResult> {
  if (source.kind === 'indexed') {
    const [rawCurrent, generation] = await Promise.all([
      source.readCurrent(),
      source.readGeneration(),
    ]);
    return Object.freeze({
      current: normalizeEvmContextGraphCurrentAuthorityState(rawCurrent),
      generation,
      stabilize: source.stabilize,
    });
  }
  const [rawCurrent, history] = await Promise.all([
    source.readCurrent(),
    source.readHistory(),
  ]);
  return Object.freeze({
    current: normalizeEvmContextGraphCurrentAuthorityState(rawCurrent),
    generation: history.state,
    stabilize: history.publish,
  });
}

export function contextGraphAuthorityEventTopics(
  contractInterface: ethers.Interface,
): readonly string[] {
  return Object.freeze(CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES.map((name) => {
    const fragment = contractInterface.getEvent(name);
    if (fragment === null) throw new Error(`ContextGraphStorage has no ${name} event`);
    return fragment.topicHash;
  }));
}

/** Convert one real ethers log into the index's closed event union. */
export function normalizeContextGraphAuthorityIndexLog(
  contractInterface: ethers.Interface,
  log: ethers.Log,
): ContextGraphAuthorityIndexEvent {
  const parsed = contractInterface.parseLog(log);
  if (parsed === null) throw new Error('ContextGraphStorage returned an unknown authority event');
  const base = {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    index: log.index,
  };
  switch (parsed.name) {
    case 'ContextGraphCreated':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
        nameHash: String(parsed.args.nameHash ?? parsed.args[2]),
      };
    case 'Transfer':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.tokenId ?? parsed.args[2]),
        from: String(parsed.args.from ?? parsed.args[0]),
        to: String(parsed.args.to ?? parsed.args[1]),
      };
    case 'PublishPolicyUpdated':
    case 'PublishAuthorityUpdated':
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
      };
    default:
      throw new Error(`Unsupported ContextGraphStorage authority event ${parsed.name}`);
  }
}
