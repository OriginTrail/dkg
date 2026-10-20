/** Charge physical inventory builds to the authenticated requesting peer. */
export class PublicSnapshotAdmission {
  private readonly peers = new Map<string, { until: number; builds: number; active: boolean }>();
  private active = 0;
  constructor(private readonly clock: () => number = Date.now, private readonly globalLimit = Infinity) {}
  acquire(peer: string): () => void {
    const now = this.clock();
    for (const [id, entry] of this.peers) {
      if (!entry.active && entry.until <= now) this.peers.delete(id);
    }
    let entry = this.peers.get(peer);
    if (!peer || this.active >= this.globalLimit || entry?.active || (entry && entry.until > now && entry.builds >= 2))
      throw new Error('Snapshot peer busy');
    if (!entry) {
      if (this.peers.size >= 1024) throw new Error('Snapshot admission busy');
      entry = { until: now + 60_000, builds: 0, active: false };
      this.peers.set(peer, entry);
    }
    // A cold build and a fresh post-transfer observation fit in one window.
    // One peer can hold only one of the two global physical builder slots.
    entry.builds += 1;
    entry.active = true;
    this.active += 1;
    return () => { if (entry.active) { entry.active = false; this.active -= 1; } };
  }
}
