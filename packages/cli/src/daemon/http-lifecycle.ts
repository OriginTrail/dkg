import type { Server, ServerResponse } from 'node:http';

/** HTTP-layer owner for the daemon's permanent SSE response state. */
export interface DaemonSseRegistry {
  readonly size: number;
  add(response: ServerResponse): void;
  delete(response: ServerResponse): void;
  broadcast(message: string): void;
  closeAll(): void;
}

export function createDaemonSseRegistry(): DaemonSseRegistry {
  const responses = new Set<ServerResponse>();
  return {
    get size() {
      return responses.size;
    },
    add(response) {
      responses.add(response);
    },
    delete(response) {
      responses.delete(response);
    },
    broadcast(message) {
      for (const response of responses) {
        try {
          response.write(message);
        } catch {
          responses.delete(response);
        }
      }
    },
    closeAll() {
      for (const response of responses) {
        try {
          response.end();
        } catch {
          // One broken stream must not prevent the rest from closing.
        }
      }
      responses.clear();
    },
  };
}

/** Server-wide owner for responses whose handler returned without ending them. */
export interface DaemonDetachedResponseRegistry {
  readonly size: number;
  track(response: ServerResponse): void;
  closeAll(): void;
}

export function createDaemonDetachedResponseRegistry(): DaemonDetachedResponseRegistry {
  const responses = new Set<ServerResponse>();
  return {
    get size() {
      return responses.size;
    },
    track(response) {
      if (response.writableEnded || response.destroyed || responses.has(response)) return;
      responses.add(response);
      const release = () => responses.delete(response);
      response.once('finish', release);
      response.once('close', release);
    },
    closeAll() {
      for (const response of responses) {
        try {
          response.end();
        } catch {
          // One broken detached response must not prevent the rest from closing.
        }
      }
      responses.clear();
    },
  };
}

/**
 * Close permanent HTTP streams first, then stop admission and wait for the
 * server's finite callbacks to drain while their dependencies are still live.
 */
export function closeDaemonHttpServer(
  server: Pick<Server, 'close'>,
  detachedResponses: DaemonDetachedResponseRegistry,
): Promise<void> {
  detachedResponses.closeAll();
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
