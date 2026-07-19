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

export function serializeSwmSenderSendState(state: LocalSwmSenderKeySendState): Record<string, unknown> {
  return {
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    chainKey: encodeWorkspaceEncryptionKey(state.chainKey),
    walEpochKey: state.walEpochKey === undefined ? undefined : encodeWorkspaceEncryptionKey(state.walEpochKey),
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
    walEpochKey: state.walEpochKey === undefined ? undefined : encodeWorkspaceEncryptionKey(state.walEpochKey),
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
    epochId: entry.epochId,
    contextGraphId: entry.contextGraphId,
    subGraphName: entry.subGraphName,
    packageBytes: encodeBytes(entry.packageBytes),
    messageId: entry.messageId,
    createdAtMs: entry.createdAtMs,
  };
}

export function deserializeSwmSenderSendState(entry: Record<string, unknown>): LocalSwmSenderKeySendState {
  const walEpochKey = optionalString(entry.walEpochKey);
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    walEpochKey: walEpochKey === undefined ? undefined : decodeWorkspaceEncryptionKey(walEpochKey),
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
  const walEpochKey = optionalString(entry.walEpochKey);
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    walEpochKey: walEpochKey === undefined ? undefined : decodeWorkspaceEncryptionKey(walEpochKey),
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
