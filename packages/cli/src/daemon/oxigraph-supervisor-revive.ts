/** Owns the pre-existing capped exponential restart counter. */
export class OxigraphSupervisorReviveBackoffV1 {
  readonly #baseMs: number;
  readonly #maxMs: number;
  #attempts = 0;

  constructor(baseMs: number, maxMs: number) {
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
  }

  reset(): void {
    this.#attempts = 0;
  }

  next(): { attempt: number; delayMs: number } {
    this.#attempts += 1;
    return {
      attempt: this.#attempts,
      delayMs: Math.min(this.#maxMs, this.#baseMs * 2 ** (this.#attempts - 1)),
    };
  }
}
