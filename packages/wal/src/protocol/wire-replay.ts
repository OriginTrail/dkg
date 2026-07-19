import { WalWireError } from './wire-error.js';
import { WAL_WIRE_ERROR_CODE } from './wire-types.js';

function idKey(id: Uint8Array): string {
  return Array.from(id, byte => byte.toString(16).padStart(2, '0')).join('');
}

interface ReplayEntry {
  readonly peerId: string;
  readonly expiresAtMs: number;
}

export interface WalReplayCacheOptions {
  maximumEntriesPerPeer: number;
  maximumEntriesGlobal: number;
}

export class WalReplayCache {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly countsByPeer = new Map<string, number>();

  constructor(private readonly options: WalReplayCacheOptions) {}

  claim(peerId: string, requestId: Uint8Array, expiresAtMs: number, nowMs: number): void {
    this.purge(nowMs);
    const key = `${peerId}:${idKey(requestId)}`;
    if (this.entries.has(key)) {
      throw new WalWireError(
        WAL_WIRE_ERROR_CODE.UNAUTHORIZED,
        'request replay rejected',
        null,
        null,
        requestId,
      );
    }
    const peerCount = this.countsByPeer.get(peerId) ?? 0;
    if (peerCount >= this.options.maximumEntriesPerPeer || this.entries.size >= this.options.maximumEntriesGlobal) {
      throw new WalWireError(
        WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT,
        'replay cache capacity is exhausted',
        null,
        null,
        requestId,
      );
    }
    this.entries.set(key, { peerId, expiresAtMs });
    this.countsByPeer.set(peerId, peerCount + 1);
  }

  purge(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > nowMs) continue;
      this.entries.delete(key);
      const count = this.countsByPeer.get(entry.peerId)! - 1;
      if (count === 0) this.countsByPeer.delete(entry.peerId);
      else this.countsByPeer.set(entry.peerId, count);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
