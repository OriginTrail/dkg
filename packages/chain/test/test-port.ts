import { createServer } from 'node:net';

/** Prefer the familiar test port; a busy port belongs to somebody else. */
export function availableTestPort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && preferred !== 0) {
        availableTestPort(0).then(resolve, reject);
      } else reject(error);
    });
    server.listen(preferred, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('test port unavailable')));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
