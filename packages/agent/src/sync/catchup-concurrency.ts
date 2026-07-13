/** Sync-owned catch-up policy; generic worker-pool mechanics live separately. */
export const CATCHUP_MAX_CONCURRENT_PEER_SYNCS: number = (() => {
  const raw = Number(process.env.DKG_CATCHUP_MAX_CONCURRENT_PEERS);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();
