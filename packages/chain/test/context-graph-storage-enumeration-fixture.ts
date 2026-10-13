// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

export const STORAGE = '0xC6C6c6C6C6c6c6c6C6c6C6c6c6C6C6C6c6c6C6c6';
export const OWNER = '0x64529c023d853371228923B4FdA5FB22F929bf51';
export const AUTHORITY = '0xbBE5eF8eC201677BBe3e4FAAbE73556b84a6eA13';
export const ANCHOR_HASH = `0x${'ab'.repeat(32)}`;

export interface FakeGraph {
  owner?: string;
  active?: boolean;
  createdAt?: number;
  accessPolicy?: number;
  publishPolicy?: number;
  publishAuthority?: string;
  nameHash?: string;
}

export function nameHashFor(id: number): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`graph-${id}`));
}

export function tuple(graph: FakeGraph): unknown[] {
  return [
    graph.owner ?? OWNER,
    [],
    0n,
    graph.active ?? true,
    BigInt(graph.createdAt ?? 1_790_152_299),
    BigInt(graph.accessPolicy ?? 0),
    BigInt(graph.publishPolicy ?? 1),
    graph.publishAuthority ?? ethers.ZeroAddress,
    0n,
  ];
}

export function graphsUpTo(count: number): Map<number, FakeGraph> {
  const graphs = new Map<number, FakeGraph>();
  for (let id = 1; id <= count; id++) {
    graphs.set(id, { nameHash: nameHashFor(id), accessPolicy: id % 2, publishPolicy: id % 3 === 0 ? 0 : 1 });
  }
  return graphs;
}

export const idsOf = (range: { entries: readonly { contextGraphId: string }[] }) =>
  range.entries.map((entry) => Number(entry.contextGraphId));
export const sequence = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

