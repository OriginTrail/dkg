// SPDX-License-Identifier: Apache-2.0

/**
 * Drain the agent, capture its final RPC accounting, close the RPC listener,
 * and only then publish the authoritative shutdown receipt.
 *
 * Keeping this sequence in one boundary prevents a failed drain from being
 * converted into apparently final RPC evidence by process orchestration.
 */
export async function emitAuthoritativeRuntimeShutdownReceiptV1({
  agent,
  emitReceipt,
  rpc,
  sealExecutedRuntimeManifest,
}) {
  await agent?.stop();
  const rpcCallCounts = rpc?.snapshot() ?? Object.freeze({});
  await rpc?.close();
  const executedRuntimeManifest = sealExecutedRuntimeManifest();
  await emitReceipt({
    executedRuntimeManifest,
    rpcCallCounts,
  });
}
