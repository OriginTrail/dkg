// SPDX-License-Identifier: Apache-2.0
import { Contract, ethers, type JsonRpcProvider } from "ethers";
import {
  MULTICALL3_ADDRESS,
  MULTICALL3_RUNTIME_CODE_HASH,
} from "./evm-background-read-batching.js";
import { EVMChainAdapterBase } from "./evm-adapter-base.js";
import { confirmedStateBlockAtHead } from "./evm-adapter-constants.js";
import { decodeKnowledgeAssetMerkleRootCount } from "./evm-knowledge-asset-update-context.js";
import { loadAbi } from "./evm-adapter-abi.js";
import {
  PUBLIC_GRAPH_SNAPSHOT_MAX_ASSETS,
  PUBLIC_GRAPH_SNAPSHOT_MAX_AGE_MS,
  sealPublicGraphSnapshot,
  decodePublicGraphSnapshot,
  type PublicGraphSnapshot,
} from "./public-graph-snapshot.js";
import { readFirstProviderWithTransientRetry } from "./rpc-provider-fallback.js";
import { isContractViewRetryable } from "./rpc-failover-client.js";
import type { ChainReadOptions } from "./chain-adapter.js";

export class PublicGraphSnapshotMethods extends EVMChainAdapterBase {
  /** A complete public inventory read at one numbered block on one endpoint. No moving-head cache mixing. */
  async readPublicGraphSnapshot(
    contextGraphId: string,
    onChainId: string,
    options: ChainReadOptions = {},
  ): Promise<PublicGraphSnapshot> {
    if (!/^[1-9][0-9]{0,77}$/.test(onChainId) || contextGraphId.length > 256)
      throw new Error("Invalid snapshot scope");
    const signal = options.signal ?? AbortSignal.timeout(110_000);
    signal.throwIfAborted();
    await this.init();
    const readOne = async (provider: JsonRpcProvider, signal: AbortSignal) => {
      const expected = BigInt(this.chainId.split(":").pop()!);
      if (BigInt(await provider.send("eth_chainId", [])) !== expected)
        throw new Error("Snapshot RPC chain mismatch");
      const observedAt = Date.now();
      const head = await provider.getBlock("latest");
      if (!head) throw new Error("Snapshot head unavailable");
      const number = confirmedStateBlockAtHead(
        head.number,
        this.finalityConfirmations,
      );
      if (number === null) throw new Error("Snapshot finality unavailable");
      const anchor = await provider.getBlock(number);
      if (!anchor?.hash) throw new Error("Snapshot anchor unavailable");
      const at = { blockTag: number };
      const hub = new Contract(this.hubAddress, loadAbi("Hub"), provider);
      const [cgAddress, kaAddress] = await Promise.all([
        hub.getAssetStorageAddress("ContextGraphStorage", at),
        hub.getAssetStorageAddress("DKGKnowledgeAssets", at),
      ]);
      const cg = new Contract(
        cgAddress,
        loadAbi("ContextGraphStorage"),
        provider,
      );
      const ka = new Contract(
        kaAddress,
        loadAbi("DKGKnowledgeAssets"),
        provider,
      );
      const id = BigInt(onChainId);
      const [state, nameHash, countRaw] = await Promise.all([
        cg.getContextGraph(id, at),
        cg.getNameHash(id, at),
        cg.getContextGraphKaCount(id, at),
      ]);
      if (
        state.active !== true ||
        Number(state.accessPolicy) !== 0 ||
        nameHash.toLowerCase() !==
          ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase()
      )
        throw new Error("Public snapshot unavailable");
      const count = BigInt(countRaw);
      if (count > BigInt(PUBLIC_GRAPH_SNAPSHOT_MAX_ASSETS))
        throw new Error("Snapshot inventory exceeds bound");
      const assets: PublicGraphSnapshot["assets"] = [];
      const multicallCode = await provider.getCode(MULTICALL3_ADDRESS, number);
      const useMulticall =
        ethers.keccak256(multicallCode) === MULTICALL3_RUNTIME_CODE_HASH;
      const calls = (items: SnapshotCall[]) =>
        readSnapshotCalls(provider, number, items, useMulticall, signal);
      for (let offset = 0; offset < Number(count); offset += 32) {
        signal.throwIfAborted();
        const size = Math.min(32, Number(count) - offset);
        const ids = await calls(
          Array.from({ length: size }, (_, i) => ({
            contract: cg,
            method: "getContextGraphKaAt",
            args: [id, offset + i],
          })),
        );
        const rows = await calls(
          ids.flatMap((assetId) => [
            { contract: ka, method: "getLatestMerkleRoot", args: [assetId] },
            {
              contract: ka,
              method: "getKnowledgeAssetUpdateContext",
              args: [assetId],
            },
            { contract: cg, method: "kaToContextGraph", args: [assetId] },
          ]),
        );
        for (let i = 0; i < size; i++) {
          const assetId = BigInt(ids[i] as bigint);
          if (BigInt(rows[i * 3 + 2] as bigint) !== id)
            throw new Error("Snapshot asset graph mismatch");
          assets.push({
            id: assetId.toString(),
            root: String(rows[i * 3]).toLowerCase(),
            version: decodeKnowledgeAssetMerkleRootCount(
              rows[i * 3 + 1],
              assetId,
            ).toString(),
          });
        }
      }
      signal.throwIfAborted();
      if (
        (await provider.getBlock(number))?.hash?.toLowerCase() !==
        anchor.hash.toLowerCase()
      )
        throw new Error("Snapshot anchor changed");
      const snapshot = sealPublicGraphSnapshot({
        version: 1,
        chainId: this.chainId,
        deploymentId: this.deploymentId,
        contextGraphId,
        onChainId,
        nameHash: nameHash.toLowerCase(),
        contextGraphStorage: cgAddress.toLowerCase(),
        assetStorage: kaAddress.toLowerCase(),
        blockNumber: String(number),
        blockHash: anchor.hash.toLowerCase(),
        finalityConfirmations: this.finalityConfirmations,
        observedAt,
        expiresAt: observedAt + PUBLIC_GRAPH_SNAPSHOT_MAX_AGE_MS,
        accessPolicy: 0,
        assets,
      });
      return decodePublicGraphSnapshot(Buffer.from(JSON.stringify(snapshot)), {
        chainId: this.chainId,
        deploymentId: this.deploymentId,
        contextGraphId,
        onChainId,
      });
    };
    const result = await readFirstProviderWithTransientRetry(this.providers, readOne, {
      signal, retryDelayMs: 250, isRetryable: isContractViewRetryable,
    });
    if (!result) throw new Error("Public snapshot unavailable");
    return result;
  }
}

interface SnapshotCall {
  contract: Contract;
  method: string;
  args: unknown[];
}
async function readSnapshotCalls(
  provider: JsonRpcProvider,
  blockTag: number,
  calls: SnapshotCall[],
  aggregate: boolean,
  signal: AbortSignal,
): Promise<unknown[]> {
  signal.throwIfAborted();
  if (aggregate) {
    const contract = new Contract(
      MULTICALL3_ADDRESS,
      [
        "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
      ],
      provider,
    );
    const result = await contract.aggregate3.staticCall(
      calls.map((c) => ({
        target: c.contract.target,
        allowFailure: false,
        callData: c.contract.interface.encodeFunctionData(c.method, c.args),
      })),
      { blockTag },
    );
    if (result.length !== calls.length)
      throw new Error("Snapshot aggregate count mismatch");
    return calls.map((c, i) => {
      if (result[i].success !== true)
        throw new Error("Snapshot aggregate read failed");
      const value = c.contract.interface.decodeFunctionResult(
        c.method,
        result[i].returnData,
      );
      return value.length === 1 ? value[0] : value;
    });
  }
  // Local development chains may not deploy Multicall3. Preserve the same anchor and cancellation.
  const result: unknown[] = Array.from({ length: calls.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, calls.length) }, async () => {
      while (next < calls.length) {
        signal.throwIfAborted();
        const i = next++;
        const c = calls[i]!;
        result[i] = await c.contract[c.method]!(...c.args, { blockTag });
      }
    }),
  );
  return result;
}
