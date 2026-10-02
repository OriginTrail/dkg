import { describe, expect, it } from 'vitest';
import {
  isEventStreamContentType,
  readEventStream,
  type EventStreamMessage,
} from '../src/ui/lib/eventStream.js';

const encoder = new TextEncoder();

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function read(chunks: Array<string | Uint8Array>): Promise<EventStreamMessage[]> {
  const messages: EventStreamMessage[] = [];
  await readEventStream(streamOf(chunks), (message) => { messages.push(message); });
  return messages;
}

// What the daemon writes: its greeting, a heartbeat comment and a broadcast
// (with a two-byte UTF-8 character, so some byte cuts fall inside it).
const NODE_FRAMES = [
  'event: connected\ndata: {}\n\n',
  ': heartbeat\n\n',
  'event: memory_graph_changed\ndata: {"contextGraphId":"cg-ž","layers":["wm"]}\n\n',
].join('');
const NODE_MESSAGES: EventStreamMessage[] = [
  { type: 'connected', data: '{}' },
  { type: 'memory_graph_changed', data: '{"contextGraphId":"cg-ž","layers":["wm"]}' },
];
const LINE_ENDINGS = ['\n', '\r\n', '\r'];

describe('readEventStream', () => {
  it('reads the frames the node writes and skips its heartbeat comment', async () => {
    expect(await read([NODE_FRAMES])).toEqual(NODE_MESSAGES);
  });

  it('accepts LF, CRLF and CR line endings', async () => {
    for (const ending of LINE_ENDINGS) {
      expect(await read([NODE_FRAMES.replaceAll('\n', ending)])).toEqual(NODE_MESSAGES);
    }
  });

  it('gives the same events wherever the bytes are split into chunks', async () => {
    for (const ending of LINE_ENDINGS) {
      const bytes = encoder.encode(NODE_FRAMES.replaceAll('\n', ending));
      for (let cut = 1; cut < bytes.length; cut++) {
        expect(await read([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(NODE_MESSAGES);
      }
      expect(await read(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toEqual(NODE_MESSAGES);
    }
  });

  it('reads a CR ending one chunk and a LF starting the next as one line break', async () => {
    // The empty chunk is what a decoder yields for a chunk holding only part of a character.
    expect(await read(['data: first\r', '', '\ndata: second\r', '\n\r\n'])).toEqual([
      { type: 'message', data: 'first\nsecond' },
    ]);
  });

  it('joins data lines with LF and removes one space after the colon', async () => {
    expect(await read(['data:  indented\ndata:unspaced\ndata\ndata: last\n\n'])).toEqual([
      { type: 'message', data: ' indented\nunspaced\n\nlast' },
    ]);
  });

  it('ignores comments and the id, retry and unknown fields', async () => {
    expect(await read([': note\nid: 7\nretry: 100\nfoo: bar\nevent: notification\ndata: {}\n\n'])).toEqual([
      { type: 'notification', data: '{}' },
    ]);
  });

  it('dispatches no event without data, and each event starts with no type', async () => {
    expect(await read(['event: join_request\n\nevent: join_approved\n\ndata: plain\n\n'])).toEqual([
      { type: 'message', data: 'plain' },
    ]);
  });

  it('drops an event the stream ends in the middle of', async () => {
    expect(await read(['event: connected\ndata: {}\n\nevent: notification\ndata: {}\n'])).toEqual([
      { type: 'connected', data: '{}' },
    ]);
  });

  it('skips a byte order mark at the start of the stream', async () => {
    expect(await read(['﻿event: connected\ndata: {}\n\n'])).toEqual([{ type: 'connected', data: '{}' }]);
  });

  it('delivers the events before a failure, then rejects with it', async () => {
    const failure = new TypeError('network error');
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));
        else controller.error(failure);
      },
    });
    const messages: EventStreamMessage[] = [];
    await expect(readEventStream(body, (message) => { messages.push(message); })).rejects.toBe(failure);
    expect(messages).toEqual([{ type: 'connected', data: '{}' }]);
  });
});

describe('isEventStreamContentType', () => {
  it('accepts the event stream type, with parameters and in any case', () => {
    expect(isEventStreamContentType('text/event-stream')).toBe(true);
    expect(isEventStreamContentType('text/event-stream; charset=utf-8')).toBe(true);
    expect(isEventStreamContentType('Text/Event-Stream;charset=UTF-8')).toBe(true);
  });

  it('rejects other types and a missing header', () => {
    expect(isEventStreamContentType('text/html; charset=utf-8')).toBe(false);
    expect(isEventStreamContentType('application/json')).toBe(false);
    expect(isEventStreamContentType(null)).toBe(false);
  });
});
