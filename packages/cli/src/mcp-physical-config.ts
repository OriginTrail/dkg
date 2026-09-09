import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpClientConfigShape } from './mcp-config-document.js';
import { mcpConfigPersistenceStrategy } from './mcp-config-metadata.js';
import { resolveMcpConfigDestination, snapshotMcpConfigSource, writeMcpConfigAtomic, type McpConfigSourceSnapshot } from './mcp-config-file.js';

type ConfigPath = Readonly<{ configPath: string; displayPath: string }>;

/** A selected physical file owns its shape and live-path validation. */
export class McpPhysicalConfig {
  readonly shape: McpClientConfigShape;
  private readonly paths: readonly ConfigPath[];

  constructor(readonly destination: string, shape: McpClientConfigShape, paths: readonly ConfigPath[]) {
    if (paths.length === 0) throw new Error('An MCP config requires a selected path');
    this.shape = Object.freeze({ format: shape.format, serverContainer: shape.serverContainer }) as McpClientConfigShape;
    this.paths = Object.freeze(paths.map(({ configPath, displayPath }) => Object.freeze({ configPath, displayPath })));
    Object.freeze(this);
  }

  get displayPath(): string { return this.paths[0]!.displayPath; }

  private assertCurrent(): void {
    for (const path of this.paths) {
      if (resolveMcpConfigDestination(path.configPath) !== this.destination) {
        throw new Error(`MCP config path changed since inspection: ${path.displayPath}. Re-run the command to confirm the current destination.`);
      }
    }
  }

  readSource(): McpConfigSourceSnapshot {
    this.assertCurrent();
    const source = snapshotMcpConfigSource(this.destination);
    this.assertCurrent();
    return source;
  }

  write(content: string, source: McpConfigSourceSnapshot): void {
    this.assertCurrent();
    if (source.destination !== this.destination) throw new Error('MCP config source belongs to a different destination');
    const persistence = mcpConfigPersistenceStrategy(this.destination);
    const directory = dirname(this.destination);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeMcpConfigAtomic(this.destination, content, persistence, source, () => this.assertCurrent());
  }
}
