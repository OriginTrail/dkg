/**
 * THE one canonical node-identity → OTel resource-attribute mapping, shared by
 * BOTH the hand-rolled log exporter (`OtlpLogWorker`) and the OTel SDK bootstrap
 * (`telemetry.ts`). Keeping a single builder is the whole point: logs, traces,
 * and metrics describe the same node, so a key/default must change in exactly
 * one place or Loki labels, trace resources, and metric resources silently drift
 * apart (review: "resource identity is duplicated between logs and traces/metrics").
 *
 * Pure (no OTel SDK, no Node built-ins) → safe to import from anywhere.
 */
export interface TelemetryResourceInput {
  /** OTel service.name. Default 'dkg-node'. */
  serviceName?: string;
  /** OTel service.version (node build version). */
  serviceVersion?: string;
  /**
   * Per-node id → service.instance.id (the Grafana node selector / Loki
   * `service_instance_id` label). Falls back to nodeName then peerId so logs and
   * traces/metrics resolve the SAME instance id even if a caller omits it.
   */
  serviceInstanceId?: string;
  /** Explicit deployment.environment; defaults to `network` when unset. */
  deploymentEnvironment?: string;
  /** testnet | mainnet | devnet → deployment.environment (default) + dkg.network. */
  network?: string;
  peerId?: string;
  nodeName?: string;
  /** 'core' | 'edge' → dkg.node.role */
  nodeRole?: string;
  commit?: string;
  /** e.g. 'base:8453' → dkg.chain */
  chainId?: string;
}

/**
 * Build the resource attribute map. Standard OTel keys (service.*, deployment.*)
 * plus the DKG identity keys (dkg.network, dkg.peer_id, dkg.node.name,
 * dkg.node.role, dkg.chain, dkg.commit). Unset values are omitted so the
 * resource never carries empty strings.
 */
export function buildTelemetryResourceAttrs(r: TelemetryResourceInput = {}): Record<string, string> {
  const attrs: Record<string, string> = { 'service.name': r.serviceName || 'dkg-node' };
  if (r.serviceVersion) attrs['service.version'] = r.serviceVersion;
  const instanceId = r.serviceInstanceId || r.nodeName || r.peerId;
  if (instanceId) attrs['service.instance.id'] = instanceId;
  const env = r.deploymentEnvironment || r.network;
  if (env) attrs['deployment.environment'] = env;
  if (r.network) attrs['dkg.network'] = r.network;
  if (r.peerId) attrs['dkg.peer_id'] = r.peerId;
  if (r.nodeName) attrs['dkg.node.name'] = r.nodeName;
  if (r.nodeRole) attrs['dkg.node.role'] = r.nodeRole;
  if (r.commit) attrs['dkg.commit'] = r.commit;
  if (r.chainId) attrs['dkg.chain'] = r.chainId;
  return attrs;
}
