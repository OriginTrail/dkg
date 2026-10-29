import { PassThrough, Writable } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { BoundedStdioServerTransport, MAX_STDIO_RESPONSE_BYTES } from '../src/bounded-stdio-transport.js';

function wireTransport() {
  const frames: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  });
  return { transport: new BoundedStdioServerTransport(new PassThrough(), output), frames };
}

describe('stdio wire size boundary', () => {
  it('accepts a frame at the byte limit, rejects the next byte, and preserves the next response', async () => {
    const { transport, frames } = wireTransport();
    const empty = { jsonrpc: '2.0' as const, id: 17, result: { text: '' } };
    const overhead = Buffer.byteLength(JSON.stringify(empty) + '\n');
    const exact = { ...empty, result: { text: 'x'.repeat(MAX_STDIO_RESPONSE_BYTES - overhead) } };
    await transport.send(exact);
    expect(Buffer.byteLength(frames[0])).toBe(MAX_STDIO_RESPONSE_BYTES);
    expect(JSON.parse(frames[0])).toEqual(exact);
    await transport.send({ ...exact, result: { text: exact.result.text + 'x' } });
    expect(JSON.parse(frames[1])).toMatchObject({ id: 17, error: { code: -32000 } });
    expect(Buffer.byteLength(frames[1])).toBeLessThan(1024);
    const small = { ...empty, result: { text: 'recovered' } };
    await transport.send(small);
    expect(JSON.parse(frames[2])).toEqual(small);
  });

  it.each(['é', '\n'])('counts UTF-8 and JSON escaping for %j, not source string length', async (character) => {
    const { transport, frames } = wireTransport();
    const text = character.repeat(MAX_STDIO_RESPONSE_BYTES / 2);
    expect(text.length).toBeLessThan(MAX_STDIO_RESPONSE_BYTES);
    await transport.send({ jsonrpc: '2.0', id: 'artifact-request', result: { text } });
    expect(JSON.parse(frames[0])).toMatchObject({ id: 'artifact-request', error: { code: -32000 } });
  });

  it('preserves protocol errors and notifications', async () => {
    const { transport, frames } = wireTransport();
    const messages: JSONRPCMessage[] = [
      { jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Invalid parameters' } },
      { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    ];
    for (const message of messages) await transport.send(message);
    expect(frames.map(frame => JSON.parse(frame))).toEqual(messages);
  });
});
