// SPDX-License-Identifier: Apache-2.0

/**
 * SWM-sender key state serialization helpers extracted from
 * `dkg-agent.ts` as part of a mechanical file-size reduction. These
 * functions are pure transformations between in-memory
 * `LocalSwmSenderKey{Send,Receive}State` plus pending setup retries
 * (declared in `dkg-agent-types.ts`) and the on-disk JSON shape
 * persisted as `swm-sender-keys.json`. No `DKGAgent` dependency.
 *
 * The `requiredString`/`optionalString`/`requiredNumber` helpers are
 * deliberately scoped to this module's deserialisers — they throw the
 * "Invalid Sender Key state" error message tied to this state schema
 * and are not a general-purpose validation library.
 */

import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import {
  encodeWorkspaceEncryptionKey,
  decodeWorkspaceEncryptionKey,
} from '@origintrail-official/dkg-core';
import type {
  LocalSwmSenderKeySendState,
  LocalSwmSenderKeyReceiveState,
  PendingSenderKeyEntry,
} from './dkg-agent-types.js';

export function swmSenderStateKey(contextGraphId: string, subGraphName: string | undefined, senderAgentAddress: string): string {
  return `${contextGraphId}\0${subGraphName ?? ''}\0${senderAgentAddress.toLowerCase()}`;
}

export function swmReceiverStateKey(
  contextGraphId: string,
  subGraphName: string | undefined,
  senderAgentAddress: string,
  epochId: string,
): string {
  return `${swmSenderStateKey(contextGraphId, subGraphName, senderAgentAddress)}\0${epochId}`;
}

// v2 invalidates route hashes written by the short-lived peer-variant build
// whose pending rows did not yet retain their destination peer. On its first
// publish after upgrade that state rotates instead of reusing an epoch whose
// remaining delivery obligations cannot be reconstructed from disk.
const SWM_SENDER_KEY_RECIPIENT_ROUTES_DOMAIN = 'dkg.swm.sender-key.recipient-routes.v2';

/**
 * Hash the exact transport routes that received (or durably queued) setup for
 * a Sender Key epoch. Logical membership remains `(agent, key)`; this separate
 * snapshot ensures that adding or removing a peer-bound variant rotates the
 * epoch without redefining the authenticated member set.
 */
export function computeSwmSenderKeyRecipientRouteHash(input: {
  contextGraphId: string;
  subGraphName?: string;
  recipients: readonly {
    agentAddress: string;
    recipientKeyId: string;
    peerId?: string;
  }[];
}): string {
  const uniqueRoutes = new Map<string, readonly [string, string, string]>();
  for (const recipient of input.recipients) {
    const route = [
      ethers.getAddress(recipient.agentAddress).toLowerCase(),
      recipient.recipientKeyId,
      recipient.peerId ?? '',
    ] as const;
    uniqueRoutes.set(JSON.stringify(route), route);
  }
  const routes = [...uniqueRoutes.values()].sort((left, right) => {
    const byAgent = left[0].localeCompare(right[0]);
    if (byAgent !== 0) return byAgent;
    const byKey = left[1].localeCompare(right[1]);
    return byKey !== 0 ? byKey : left[2].localeCompare(right[2]);
  });
  const digest = createHash('sha256')
    .update(JSON.stringify({
      domain: SWM_SENDER_KEY_RECIPIENT_ROUTES_DOMAIN,
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName ?? '',
      routes,
    }))
    .digest('hex');
  return `sha256:${digest}`;
}

export function serializeSwmSenderSendState(state: LocalSwmSenderKeySendState): Record<string, unknown> {
  return {
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    recipientRouteHash: state.recipientRouteHash,
    chainKey: encodeWorkspaceEncryptionKey(state.chainKey),
    nextMessageIndex: state.nextMessageIndex,
    senderSigningSecretKey: encodeWorkspaceEncryptionKey(state.senderSigningSecretKey),
    senderSigningPublicKey: encodeWorkspaceEncryptionKey(state.senderSigningPublicKey),
    createdAtMs: state.createdAtMs,
  };
}

export function serializeSwmSenderReceiveState(state: LocalSwmSenderKeyReceiveState): Record<string, unknown> {
  return {
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    chainKey: encodeWorkspaceEncryptionKey(state.chainKey),
    nextMessageIndex: state.nextMessageIndex,
    senderSigningPublicKey: encodeWorkspaceEncryptionKey(state.senderSigningPublicKey),
    createdAtMs: state.createdAtMs,
    skippedChainKeys: [...state.skippedChainKeys.entries()].map(([index, chainKey]) => ({
      index,
      chainKey: encodeWorkspaceEncryptionKey(chainKey),
    })),
  };
}

export function serializePendingSenderKeyEntry(entry: PendingSenderKeyEntry): Record<string, unknown> {
  return {
    senderAgentAddress: entry.senderAgentAddress,
    recipientAgentAddress: entry.recipientAgentAddress,
    recipientKeyId: entry.recipientKeyId,
    recipientPeerId: entry.recipientPeerId,
    epochId: entry.epochId,
    contextGraphId: entry.contextGraphId,
    subGraphName: entry.subGraphName,
    packageBytes: encodeBytes(entry.packageBytes),
    messageId: entry.messageId,
    createdAtMs: entry.createdAtMs,
  };
}

export function deserializeSwmSenderSendState(entry: Record<string, unknown>): LocalSwmSenderKeySendState {
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    recipientRouteHash: optionalString(entry.recipientRouteHash),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    nextMessageIndex: requiredNumber(entry.nextMessageIndex, 'nextMessageIndex'),
    senderSigningSecretKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningSecretKey, 'senderSigningSecretKey')),
    senderSigningPublicKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningPublicKey, 'senderSigningPublicKey')),
    createdAtMs: requiredNumber(entry.createdAtMs, 'createdAtMs'),
  };
}

export function deserializeSwmSenderReceiveState(entry: Record<string, unknown>): LocalSwmSenderKeyReceiveState {
  const skippedChainKeys = new Map<number, Uint8Array>();
  const skipped = Array.isArray(entry.skippedChainKeys) ? entry.skippedChainKeys : [];
  for (const raw of skipped) {
    const item = raw as Record<string, unknown>;
    skippedChainKeys.set(
      requiredNumber(item.index, 'skippedChainKeys.index'),
      decodeWorkspaceEncryptionKey(requiredString(item.chainKey, 'skippedChainKeys.chainKey')),
    );
  }
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    nextMessageIndex: requiredNumber(entry.nextMessageIndex, 'nextMessageIndex'),
    senderSigningPublicKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningPublicKey, 'senderSigningPublicKey')),
    createdAtMs: requiredNumber(entry.createdAtMs, 'createdAtMs'),
    skippedChainKeys,
  };
}

export function deserializePendingSenderKeyEntry(entry: Record<string, unknown>): PendingSenderKeyEntry {
  const senderAgentAddress = ethers.getAddress(requiredString(entry.senderAgentAddress, 'pending.senderAgentAddress'));
  const recipientAgentAddress = ethers.getAddress(requiredString(entry.recipientAgentAddress, 'pending.recipientAgentAddress'));
  return {
    senderAgentAddress: senderAgentAddress.toLowerCase(),
    recipientAgentAddress: recipientAgentAddress.toLowerCase(),
    recipientKeyId: requiredString(entry.recipientKeyId, 'pending.recipientKeyId'),
    recipientPeerId: optionalString(entry.recipientPeerId),
    epochId: requiredString(entry.epochId, 'pending.epochId'),
    contextGraphId: requiredString(entry.contextGraphId, 'pending.contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    packageBytes: decodeBytes(requiredString(entry.packageBytes, 'pending.packageBytes')),
    messageId: optionalString(entry.messageId),
    createdAtMs: requiredNumber(entry.createdAtMs, 'pending.createdAtMs'),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Sender Key state: ${name} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid Sender Key state: ${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid Sender Key state: packageBytes must be strict base64');
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}
