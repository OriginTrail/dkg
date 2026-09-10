// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ContextGraphPublishDomainV1 } from '@origintrail-official/dkg-core';
import type { ContextGraphAuthorityHistoryResolution } from './context-graph-authority-history.js';
import type {
  ContextGraphAuthorityIndexState,
} from './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexEvent } from './context-graph-authority-index-reducer.js';
import {
  normalizeContextGraphAuthorityAccessPolicy,
  normalizeContextGraphAuthorityPublishDomain,
  normalizeContextGraphAuthorityPublishReference,
  type ContextGraphAuthorityState,
} from './context-graph-authority-state.js';

export const CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES = Object.freeze([
  'ContextGraphCreated',
  'ContextGraphDeactivated',
  'Transfer',
  'PublishPolicyUpdated',
  'PublishAuthorityUpdated',
  'AgentParticipantAdded',
  'AgentParticipantRemoved',
] as const);

export type EvmContextGraphCurrentAuthorityState = Readonly<{
  owner: string;
  active: boolean;
  accessPolicy: ContextGraphAuthorityState['accessPolicy'];
  participantAgents: readonly string[];
}> & ContextGraphPublishDomainV1;

export interface EvmContextGraphAuthoritySourceResult {
  readonly state: ContextGraphAuthorityState;
  /** Final cross-read fence or legacy checkpoint publication. */
  stabilize(): Promise<void>;
}

export type EvmContextGraphAuthoritySource =
  | Readonly<{
      kind: 'indexed';
      readSnapshot(): Promise<ContextGraphAuthorityIndexState>;
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
  const accessPolicy = normalizeContextGraphAuthorityAccessPolicy(
    Number(BigInt(tupleField(value, 'accessPolicy', 5) as ethers.BigNumberish)),
  );
  if (accessPolicy === undefined) throw new Error('Context Graph access policy is invalid');
  const publishDomain = normalizeContextGraphAuthorityPublishDomain(
    Number(BigInt(tupleField(value, 'publishPolicy', 6) as ethers.BigNumberish)),
    authority,
    accountId,
  );
  if (publishDomain === undefined) throw new Error('Context Graph publish policy is invalid');
  return Object.freeze({
    owner,
    active: Boolean(tupleField(value, 'active', 3)),
    accessPolicy,
    ...publishDomain,
    participantAgents: Object.freeze(participantAgents),
  });
}

/** Resolve either authority source into one typed model for snapshot assembly. */
export async function resolveEvmContextGraphAuthoritySource(
  source: EvmContextGraphAuthoritySource,
): Promise<EvmContextGraphAuthoritySourceResult> {
  if (source.kind === 'indexed') {
    const indexed = await source.readSnapshot();
    return Object.freeze({
      state: indexed,
      stabilize: source.stabilize,
    });
  }
  const [rawCurrent, history] = await Promise.all([
    source.readCurrent(),
    source.readHistory(),
  ]);
  const { throughBlockNumber: _number, throughBlockHash: _hash, ...generation } =
    history.state;
  return Object.freeze({
    state: Object.freeze(Object.assign(
      {},
      normalizeEvmContextGraphCurrentAuthorityState(rawCurrent),
      generation,
    )),
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
    case 'ContextGraphCreated': {
      const accessPolicy = normalizeContextGraphAuthorityAccessPolicy(
        Number(BigInt(parsed.args.accessPolicy ?? parsed.args[5])),
      );
      const publishDomain = normalizeContextGraphAuthorityPublishDomain(
        Number(BigInt(parsed.args.publishPolicy ?? parsed.args[6])),
        String(parsed.args.publishAuthority ?? parsed.args[7]),
        BigInt(parsed.args.publishAuthorityAccountId ?? parsed.args[8]),
      );
      if (accessPolicy === undefined || publishDomain === undefined) {
        throw new Error('ContextGraphStorage returned an invalid creation authority domain');
      }
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
        owner: String(parsed.args.owner ?? parsed.args[1]),
        nameHash: String(parsed.args.nameHash ?? parsed.args[2]),
        participantAgents: [
          ...(parsed.args.participantAgents ?? parsed.args[3]),
        ].map((address) => String(address)),
        accessPolicy,
        ...publishDomain,
      };
    }
    case 'Transfer':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.tokenId ?? parsed.args[2]),
        from: String(parsed.args.from ?? parsed.args[0]),
        to: String(parsed.args.to ?? parsed.args[1]),
      };
    case 'PublishPolicyUpdated': {
      const publishDomain = normalizeContextGraphAuthorityPublishDomain(
        Number(BigInt(parsed.args.publishPolicy ?? parsed.args[1])),
        String(parsed.args.publishAuthority ?? parsed.args[2]),
        BigInt(parsed.args.publishAuthorityAccountId ?? parsed.args[3]),
      );
      if (publishDomain === undefined) {
        throw new Error('ContextGraphStorage returned an invalid publish-policy domain');
      }
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
        ...publishDomain,
      };
    }
    case 'PublishAuthorityUpdated': {
      const publishReference = normalizeContextGraphAuthorityPublishReference(
        String(parsed.args.newAuthority ?? parsed.args[1]),
        BigInt(parsed.args.newAuthorityAccountId ?? parsed.args[2]),
      );
      if (publishReference === undefined) {
        throw new Error('ContextGraphStorage returned an invalid publish-authority reference');
      }
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
        ...publishReference,
      };
    }
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
        agent: String(parsed.args.agent ?? parsed.args[1]),
      };
    case 'ContextGraphDeactivated':
      return {
        ...base,
        name: parsed.name,
        contextGraphId: BigInt(parsed.args.contextGraphId ?? parsed.args[0]),
      };
    default:
      throw new Error(`Unsupported ContextGraphStorage authority event ${parsed.name}`);
  }
}
