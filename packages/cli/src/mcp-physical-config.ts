import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpClientConfigShape } from './mcp-config-document.js';
import { mcpConfigPersistenceStrategy } from './mcp-config-metadata.js';
import {
  resolveMcpConfigDestination,
  snapshotMcpConfigSource,
  writeMcpConfigAtomic,
  type McpConfigSourceSnapshot,
} from './mcp-config-file.js';

export type McpPhysicalConfigPath = Readonly<{
  configPath: string;
  displayPath: string;
}> & McpClientConfigShape;

const MCP_PHYSICAL_CONFIG_OWNER: unique symbol = Symbol('McpPhysicalConfig owner');

/** A source snapshot is a capability owned by exactly one physical selection. */
export interface McpPhysicalConfigSourceSnapshot extends McpConfigSourceSnapshot {
  readonly [MCP_PHYSICAL_CONFIG_OWNER]: symbol;
}

/** A selected physical file owns its shape and live-path validation. */
export class McpPhysicalConfig {
  readonly shape: McpClientConfigShape;
  private readonly paths: readonly McpPhysicalConfigPath[];
  private readonly ownerToken = Symbol('McpPhysicalConfig owner');

  private constructor(readonly destination: string, shape: McpClientConfigShape, paths: readonly McpPhysicalConfigPath[]) {
    this.shape = Object.freeze({ format: shape.format, serverContainer: shape.serverContainer }) as McpClientConfigShape;
    this.paths = Object.freeze(paths.map(path => Object.freeze({ ...path })));
    Object.freeze(this);
  }

  /** Derive path, document shape, and aliases at the only construction boundary. */
  static create(paths: readonly McpPhysicalConfigPath[]): McpPhysicalConfig {
    const first = paths[0];
    if (!first) throw new Error('An MCP config requires a selected path');
    const destination = resolveMcpConfigDestination(first.configPath);
    for (const path of paths) {
      if (
        path.format !== first.format
        || path.serverContainer !== first.serverContainer
      ) {
        throw new Error('MCP config aliases disagree about their document shape');
      }
      if (resolveMcpConfigDestination(path.configPath) !== destination) {
        throw new Error('MCP config aliases resolve to different destinations');
      }
    }
    return new McpPhysicalConfig(destination, first, paths);
  }

  get displayPath(): string { return this.paths[0]!.displayPath; }

  readSource(): McpPhysicalConfigSourceSnapshot {
    return Object.freeze({
      ...snapshotMcpConfigSource(this.destination, this.paths),
      [MCP_PHYSICAL_CONFIG_OWNER]: this.ownerToken,
    });
  }

  write(content: string, source: McpPhysicalConfigSourceSnapshot): void {
    if (source[MCP_PHYSICAL_CONFIG_OWNER] !== this.ownerToken) {
      throw new Error('MCP config source belongs to a different physical config owner');
    }
    if (source.destination !== this.destination) throw new Error('MCP config source belongs to a different destination');
    const persistence = mcpConfigPersistenceStrategy(this.destination);
    const directory = dirname(this.destination);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeMcpConfigAtomic(this.destination, content, persistence, source);
  }
}
