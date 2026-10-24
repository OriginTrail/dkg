import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoundedStdioServerTransport } from '../../src/bounded-stdio-transport.js';
import { registerAssertionTools } from '../../src/tools/assertions.js';
import { FakeClient, makeConfig } from '../harness.js';

const server = new McpServer({ name: 'large-response-test', version: '0.0.0' });
const client = new FakeClient({
  async readImportArtifactMarkdown(args) {
    const artifact = await this.resolveImportArtifact(args);
    const bytes = Math.min(args.maxBytes ?? 1024, 5 * 1024 * 1024);
    return {
      ...artifact,
      markdownHash: `sha256:${'b'.repeat(64)}`,
      contentType: 'text/markdown',
      bytes,
      markdown: 'x\n'.repeat(bytes / 2),
    };
  },
});
registerAssertionTools(server, client.asDkgClient(), makeConfig());
server.registerTool('large_query', { inputSchema: {} }, async () => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ rows: ['\u0000'.repeat(2 * 1024 * 1024)] }) }],
}));
await server.connect(new BoundedStdioServerTransport());
