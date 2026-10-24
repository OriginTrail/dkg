import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('bounded stdio responses', () => {
  it('keeps a real child session usable after oversized artifact and query results', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/large-stdio-server.ts', import.meta.url))],
      stderr: 'pipe',
      // Deliberately retain the SDK's default 10 MiB receive limit.
    });
    const client = new Client({ name: 'bounded-response-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const pid = transport.pid;
      const readArtifact = (maxBytes: number) => client.callTool({
        name: 'dkg_knowledge_asset_import_artifact_read_markdown',
        arguments: { projectId: 'test-project', assertionUri: 'urn:test:artifact', maxBytes },
      });

      await expect(readArtifact(5 * 1024 * 1024)).rejects.toThrow('8 MiB serialized MCP limit');
      const retry = await readArtifact(1024);
      expect(retry.isError).toBeFalsy();
      expect(JSON.stringify(retry.content)).toContain('Imported artifact Markdown');
      await expect(client.callTool({ name: 'large_query', arguments: {} }))
        .rejects.toThrow('narrow/paginate the query');
      expect((await client.listTools()).tools.length).toBeGreaterThan(1);
      expect(transport.pid).toBe(pid);
    } finally {
      await client.close();
    }
  }, 30_000);
});
