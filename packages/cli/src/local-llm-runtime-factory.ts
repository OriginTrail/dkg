import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DkgLocalLlmRuntime,
  TextInteractionTrace,
  type DkgLocalLlmDomainProfile,
  type McpClientLike,
  type ToolProfile,
} from '@origintrail-official/dkg-local-llm';

export interface DkgLocalLlmRuntimeSessionOptions {
  dkgHome: string;
  llamaUrl: string;
  model: string;
  projectId?: string;
  strictProjectScope?: boolean;
  strictProjectScopeTools?: readonly string[];
  strictProjectScopeUnscopedTools?: readonly string[];
  profile?: ToolProfile;
  allowWrite?: boolean;
  adapterPaths?: readonly string[];
  additionalToolNames?: readonly string[];
  domainProfile?: DkgLocalLlmDomainProfile;
  systemContextAddendum?: string;
  logDir: string;
  logFile?: string;
  maxToolCalls?: number;
  maxToolsPerTurn?: number;
  maxToolJsonBytes?: number;
  maxEvidenceChars?: number;
  maxSessionTurns?: number;
  maxSessionChars?: number;
  requestTimeoutMs?: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  cwd?: string;
  stderr?: (line: string) => void;
}

export interface DkgLocalLlmRuntimeSession {
  runtime: DkgLocalLlmRuntime;
  trace: TextInteractionTrace;
  close(): Promise<void>;
}

function currentCliPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

/**
 * Build the runtime plus its private stdio MCP child. Both the CLI and daemon
 * use this owner so schema discovery, tracing, environment scoping, and child
 * cleanup cannot drift between the two entry points.
 */
export async function createDkgLocalLlmRuntimeSession(
  options: DkgLocalLlmRuntimeSessionOptions,
): Promise<DkgLocalLlmRuntimeSession> {
  const trace = await TextInteractionTrace.create({
    logDir: options.logDir,
    logFile: options.logFile,
  });
  const environment: Record<string, string> = {
    ...getDefaultEnvironment(),
    DKG_HOME: options.dkgHome,
  };
  const projectId = options.projectId?.trim();
  if (projectId) environment.DKG_PROJECT = projectId;
  else delete environment.DKG_PROJECT;
  if (options.adapterPaths?.length) {
    environment.DKG_ADAPTERS = options.adapterPaths.join(',');
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [currentCliPath(), 'mcp', 'serve'],
    cwd: options.cwd ?? process.cwd(),
    stderr: 'pipe',
    env: environment,
  });
  transport.stderr?.on('data', (chunk) => {
    const line = String(chunk).trimEnd();
    if (!line) return;
    options.stderr?.(line);
    void trace.write('DKG MCP STDERR', line);
  });

  const mcp = new Client({ name: 'dkg-local-llm', version: '10.0.14' });
  let closed = false;
  try {
    await mcp.connect(transport);
    const runtimeMcp: McpClientLike = {
      listTools: () => mcp.listTools(),
      callTool: async (input, requestOptions) => await mcp.callTool(
        input,
        undefined,
        requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
      ) as unknown as Awaited<ReturnType<McpClientLike['callTool']>>,
    };
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: runtimeMcp,
      llamaUrl: options.llamaUrl,
      model: options.model,
      projectId,
      strictProjectScope: options.strictProjectScope,
      strictProjectScopeTools: [...(options.strictProjectScopeTools ?? [])],
      strictProjectScopeUnscopedTools: [...(options.strictProjectScopeUnscopedTools ?? [])],
      profile: options.profile,
      allowWrite: options.allowWrite,
      additionalToolNames: [...(options.additionalToolNames ?? [])],
      domainProfile: options.domainProfile,
      systemContextAddendum: options.systemContextAddendum,
      temperature: options.temperature,
      topP: options.topP,
      maxTokens: options.maxTokens,
      maxToolCalls: options.maxToolCalls,
      maxToolsPerTurn: options.maxToolsPerTurn,
      maxToolJsonBytes: options.maxToolJsonBytes,
      maxEvidenceChars: options.maxEvidenceChars,
      maxSessionTurns: options.maxSessionTurns,
      maxSessionChars: options.maxSessionChars,
      requestTimeoutMs: options.requestTimeoutMs,
      trace,
    });
    return {
      runtime,
      trace,
      async close() {
        if (closed) return;
        closed = true;
        await trace.write('SESSION CLOSED').catch(() => undefined);
        await mcp.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await mcp.close().catch(() => undefined);
    throw error;
  }
}
