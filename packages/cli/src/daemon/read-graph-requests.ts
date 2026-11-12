/**
 * The read-graph requests a daemon runs. Graceful shutdown ends them at once
 * ({@link end}), before the HTTP server drains: each stops at its next store
 * call and answers, and a later check, rebuild or drop is refused.
 */
export class ReadGraphRequests {
  #ending = false;
  readonly #running = new Set<AbortController>();

  get ending(): boolean {
    return this.#ending;
  }

  /** Track a request until the returned function is called. */
  track(request: AbortController): () => void {
    this.#running.add(request);
    return () => {
      this.#running.delete(request);
    };
  }

  end(): void {
    this.#ending = true;
    for (const request of this.#running) request.abort(new Error('The node is shutting down'));
  }
}

/** The daemon's read-graph requests, which its graceful shutdown ends. */
export const daemonReadGraphRequests = new ReadGraphRequests();

export const SHUTTING_DOWN = { code: 'NODE_SHUTTING_DOWN', error: 'The node is shutting down; try again once it is back.', retryable: true } as const;
