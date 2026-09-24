import type { Connection } from '@libp2p/interface';

/** Preserve the cause carried by the individual connection, before the global
 * connection:close event reduces it to a Connection object. */
export function observeConnectionClose(connection: Connection, log: (message: string) => void): void {
  connection.addEventListener('close', (event) => {
    const initiator = event.local === true ? 'local' : event.local === false ? 'remote' : 'unknown';
    const name = event.error?.name?.slice(0, 80) ?? 'none';
    const message = event.error?.message?.slice(0, 240) ?? '';
    log(`Connection close cause: ${connection.remotePeer.toString().slice(-8)} `
      + `id=${connection.id} initiator=${initiator} error=${JSON.stringify(name)} message=${JSON.stringify(message)}`);
  }, { once: true });
}
