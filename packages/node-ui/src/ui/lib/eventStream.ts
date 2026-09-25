// Reader for a server-sent events (`text/event-stream`) response body.
//
// The dashboard reads the node's event stream with `fetch`, which lets it send
// the API token in the Authorization header. Lines and fields are interpreted
// as the HTML standard's event stream format defines them: LF, CRLF or CR line
// endings, `:` comment lines, at most one space removed after a field's colon,
// and the `data` lines of one event joined with LF. The `id` and `retry` fields
// are not used, and an event that the stream ends in the middle of is dropped.

export interface EventStreamMessage {
  /** The event's `event` field, or `message` when it has none. */
  type: string;
  /** The event's `data` lines, joined with LF. */
  data: string;
}

const LF = 0x0a;
const CR = 0x0d;

/** True when `contentType` names the event stream media type (parameters such as charset allowed). */
export function isEventStreamContentType(contentType: string | null): boolean {
  return (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream';
}

/**
 * Read `body` to its end, calling `onMessage` for each complete event.
 * Resolves when the stream ends; rejects when it fails or is aborted.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: EventStreamMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const push = createEventStreamParser(onMessage);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    push(decoder.decode(value, { stream: true }));
  }
}

/** Returns a function that takes decoded text in chunks of any size. */
function createEventStreamParser(onMessage: (message: EventStreamMessage) => void): (chunk: string) => void {
  let pending = '';
  // The last chunk ended with CR: a LF starting the next chunk belongs to the same line break.
  let afterCarriageReturn = false;
  let eventType = '';
  let dataLines: string[] = [];

  // A blank line ends the event. One without data lines is not dispatched.
  const dispatch = () => {
    const type = eventType || 'message';
    const lines = dataLines;
    eventType = '';
    dataLines = [];
    if (lines.length > 0) onMessage({ type, data: lines.join('\n') });
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
  };

  return (chunk) => {
    let text = chunk;
    if (afterCarriageReturn && text.length > 0) {
      afterCarriageReturn = false;
      if (text.charCodeAt(0) === LF) text = text.slice(1);
    }
    const buffer = pending + text;
    let lineStart = 0;
    for (let i = 0; i < buffer.length; i++) {
      const code = buffer.charCodeAt(i);
      if (code !== LF && code !== CR) continue;
      processLine(buffer.slice(lineStart, i));
      if (code === CR) {
        if (i + 1 === buffer.length) afterCarriageReturn = true;
        else if (buffer.charCodeAt(i + 1) === LF) i++;
      }
      lineStart = i + 1;
    }
    pending = buffer.slice(lineStart);
  };
}
