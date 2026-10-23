/** FIFO ownership of physical slots; logical admission/drain remains with the caller. */
export class BoundedWork {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid bounded work concurrency');
  }

  async run<T>(start: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active += 1;
    try { return await start(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // Transfer directly so a new arrival cannot steal the waiting slot.
      else this.active -= 1;
    }
  }
}
