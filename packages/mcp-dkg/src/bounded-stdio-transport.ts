import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// Leave room below the SDK client's 10 MiB receive-buffer limit for framing
// and coalesced messages. Count the wire JSON, including nested JSON escaping,
// rather than the source artifact's bytes or the number of query rows.
export const MAX_STDIO_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reject oversized results without closing a client's persistent session. */
export class BoundedStdioServerTransport extends StdioServerTransport {
  override async send(message: JSONRPCMessage): Promise<void> {
    if ('result' in message
      && Buffer.byteLength(JSON.stringify(message) + '\n', 'utf8') > MAX_STDIO_RESPONSE_BYTES) {
      await super.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: 'DKG response exceeds the 8 MiB serialized MCP limit. '
            + 'Read the artifact with a smaller maxBytes value, or narrow/paginate the query. '
            + 'The session remains available for subsequent calls.',
        },
      });
      return;
    }
    await super.send(message);
  }
}
