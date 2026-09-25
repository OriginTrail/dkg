import { describe, expect, it } from 'vitest';
import { StreamCloseEvent, type Connection } from '@libp2p/interface';
import { observeConnectionClose } from '../src/connection-close-diagnostics.js';

describe('connection close diagnostics', () => {
  it('accepts metadata-only connection notifications without interrupting the open listener', () => {
    const connection = {
      id: 'metadata-only', remotePeer: { toString: () => 'peer-12345678' },
    } as unknown as Connection;
    const lines: string[] = [];
    expect(() => observeConnectionClose(connection, (line) => lines.push(line))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('preserves the local failure, escapes the message, and records one cause per connection', () => {
    const connection = Object.assign(new EventTarget(), {
      id: 'connection-1', remotePeer: { toString: () => 'peer-12345678' },
    }) as unknown as Connection;
    const lines: string[] = [];
    observeConnectionClose(connection, (line) => lines.push(line));
    const error = new Error('deadline\nexpired');
    error.name = 'TimeoutError';
    connection.dispatchEvent(new StreamCloseEvent(true, error));
    connection.dispatchEvent(new StreamCloseEvent(false));
    expect(lines).toEqual([
      'Connection close cause: 12345678 id=connection-1 initiator=local error="TimeoutError" message="deadline\\nexpired"',
    ]);
  });

  it('does not guess an initiator when the transport supplied no cause', () => {
    const connection = Object.assign(new EventTarget(), {
      id: 'connection-2', remotePeer: { toString: () => 'peer-12345678' },
    }) as unknown as Connection;
    const lines: string[] = [];
    observeConnectionClose(connection, (line) => lines.push(line));
    connection.dispatchEvent(new StreamCloseEvent());
    expect(lines[0]).toContain('initiator=unknown error="none" message=""');
  });
});
