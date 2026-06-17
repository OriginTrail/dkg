/** Per-member daily request counter (UTC-day buckets, in-memory). */
export class DailyQuota {
  private readonly maxPerDay: number;
  private readonly now: () => number;
  private day = '';
  private counts = new Map<string, number>();

  constructor(maxPerDay: number, now: () => number = () => Date.now()) {
    this.maxPerDay = Math.max(0, maxPerDay);
    this.now = now;
  }

  private rollover(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
  }

  /** Returns true and records the hit if under cap; false if over. */
  allow(key: string): boolean {
    this.rollover();
    const used = this.counts.get(key) ?? 0;
    if (used >= this.maxPerDay) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  remaining(key: string): number {
    this.rollover();
    return Math.max(0, this.maxPerDay - (this.counts.get(key) ?? 0));
  }
}
