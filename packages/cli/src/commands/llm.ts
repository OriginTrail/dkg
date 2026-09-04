import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  DkgLocalLlmRuntime,
  parseDomainProfile,
  type ToolProfile,
} from '@origintrail-official/dkg-local-llm';
import { resolveDkgConfigHome } from '@origintrail-official/dkg-core';
import { createDkgLocalLlmRuntimeSession } from '../local-llm-runtime-factory.js';

export interface LlmCommandOptions {
  interactive?: boolean;
  llamaUrl?: string;
  model?: string;
  project?: string;
  profile?: string;
  allowWrite?: boolean;
  adapter?: string[];
  tool?: string[];
  systemContextFile?: string;
  domainProfile?: string;
  logDir?: string;
  logFile?: string;
  maxToolCalls?: string;
  maxTools?: string;
  maxToolJsonBytes?: string;
  maxEvidenceChars?: string;
  sessionTurns?: string;
  sessionChars?: string;
  requestTimeoutMs?: string;
  temperature?: string;
  topP?: string;
  maxTokens?: string;
}

export interface ResolvedLlmCommandOptions {
  prompt?: string;
  interactive: boolean;
  dkgHome: string;
  llamaUrl: string;
  model: string;
  projectId?: string;
  profile: ToolProfile;
  allowWrite: boolean;
  adapterPaths: string[];
  additionalToolNames: string[];
  systemContextFile?: string;
  domainProfileFile?: string;
  logDir: string;
  logFile?: string;
  maxToolCalls: number;
  maxToolsPerTurn: number;
  maxToolJsonBytes: number;
  maxEvidenceChars: number;
  maxSessionTurns: number;
  maxSessionChars: number;
  requestTimeoutMs: number;
  temperature: number;
  topP: number;
  maxTokens: number;
}

function finiteNumber(label: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function positiveInteger(label: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function parseProfile(raw: string | undefined): ToolProfile {
  const profile = raw?.trim() || 'auto';
  if (!['auto', 'chat', 'status', 'catalog', 'read', 'write'].includes(profile)) {
    throw new Error('--profile must be one of: auto, chat, status, catalog, read, write.');
  }
  return profile as ToolProfile;
}

function environmentList(value: string | undefined): string[] {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
}

export function resolveLlmCommandOptions(
  promptParts: readonly string[],
  options: LlmCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLlmCommandOptions {
  const prompt = promptParts.join(' ').trim() || undefined;
  const dkgHome = resolveDkgConfigHome({ env });
  const adapterPaths = (options.adapter ?? environmentList(env.DKG_ADAPTERS))
    .map((entry) => path.resolve(entry));
  return {
    prompt,
    interactive: options.interactive ?? !prompt,
    dkgHome,
    llamaUrl: options.llamaUrl?.trim()
      || env.DKG_LLM_URL?.trim()
      || env.LLAMA_URL?.trim()
      || 'http://127.0.0.1:8080/v1/chat/completions',
    model: options.model?.trim() || env.DKG_LLM_MODEL?.trim() || env.LLAMA_MODEL?.trim() || 'local-model',
    // A shell-level DKG_PROJECT remains useful for the regular CLI/MCP
    // workflow, but it is too easy to apply invisibly to an interactive
    // multi-graph agent. Only --project explicitly pins an LLM session.
    projectId: options.project?.trim() || undefined,
    profile: parseProfile(options.profile),
    allowWrite: options.allowWrite ?? false,
    adapterPaths,
    additionalToolNames: [...new Set(options.tool ?? [])],
    systemContextFile: options.systemContextFile ? path.resolve(options.systemContextFile) : undefined,
    domainProfileFile: options.domainProfile ? path.resolve(options.domainProfile) : undefined,
    logDir: path.resolve(options.logDir ?? path.join(dkgHome, 'logs/local-llm')),
    logFile: options.logFile ? path.resolve(options.logFile) : undefined,
    maxToolCalls: positiveInteger('--max-tool-calls', options.maxToolCalls, 4),
    maxToolsPerTurn: positiveInteger('--max-tools', options.maxTools, 8),
    maxToolJsonBytes: positiveInteger('--max-tool-json-bytes', options.maxToolJsonBytes, 18_000),
    maxEvidenceChars: positiveInteger('--max-evidence-chars', options.maxEvidenceChars, 12_000),
    maxSessionTurns: positiveInteger('--session-turns', options.sessionTurns, 6),
    maxSessionChars: positiveInteger('--session-chars', options.sessionChars, 8_000),
    requestTimeoutMs: positiveInteger('--request-timeout-ms', options.requestTimeoutMs, 120_000),
    temperature: finiteNumber('--temperature', options.temperature, 0.15),
    topP: finiteNumber('--top-p', options.topP, 0.9),
    maxTokens: positiveInteger('--max-tokens', options.maxTokens, 1_024),
  };
}

type InteractiveRuntime = Pick<
  DkgLocalLlmRuntime,
  'clearSession' | 'getAvailableToolNames' | 'getSessionHistory' | 'getSessionInfo'
>;

export interface InteractiveCommandResult {
  handled: boolean;
  exit?: boolean;
  output?: string;
}

function renderHistory(runtime: InteractiveRuntime): string {
  const history = runtime.getSessionHistory();
  if (!history.length) return 'Session history is empty.';
  return history.map((turn) => [
    `[${turn.turn}] You: ${turn.user}`,
    `    Assistant: ${turn.assistant}`,
    `    Evidence: ${turn.evidence.map((item) => item.name).join(', ') || 'none'}`,
  ].join('\n')).join('\n\n');
}

export async function handleLlmInteractiveCommand(
  input: string,
  runtime: InteractiveRuntime,
  traceFile?: string,
): Promise<InteractiveCommandResult> {
  const command = input.trim().toLowerCase();
  if (!command.startsWith('/') && command !== 'exit' && command !== 'quit') return { handled: false };
  if (['/exit', '/quit', 'exit', 'quit'].includes(command)) return { handled: true, exit: true };
  if (command === '/clear') {
    await runtime.clearSession();
    return { handled: true, output: 'Session history cleared.' };
  }
  if (command === '/history') return { handled: true, output: renderHistory(runtime) };
  if (command === '/tools') {
    return {
      handled: true,
      output: `MCP-compatible tools:\n${runtime.getAvailableToolNames().map((name) => `- ${name}`).join('\n')}`,
    };
  }
  if (command === '/log') {
    return { handled: true, output: traceFile ? `Interaction log: ${traceFile}` : 'No trace file configured.' };
  }
  if (command === '/help') {
    const info = runtime.getSessionInfo();
    return {
      handled: true,
      output: [
        'Commands: /clear, /history, /tools, /log, /help, /exit',
        `Session budget: ${info.maxTurns} turns, ${info.maxChars} characters of prior context.`,
      ].join('\n'),
    };
  }
  return { handled: true, output: `Unknown command '${input}'. Use /help.` };
}

export async function runLlmCommand(options: ResolvedLlmCommandOptions): Promise<void> {
  const systemContextAddendum = options.systemContextFile
    ? await readFile(options.systemContextFile, 'utf8')
    : undefined;
  const domainProfile = options.domainProfileFile
    ? parseDomainProfile(JSON.parse(await readFile(options.domainProfileFile, 'utf8')))
    : undefined;
  const session = await createDkgLocalLlmRuntimeSession({
    dkgHome: options.dkgHome,
    llamaUrl: options.llamaUrl,
    model: options.model,
    projectId: options.projectId,
    profile: options.profile,
    allowWrite: options.allowWrite,
    adapterPaths: options.adapterPaths,
    additionalToolNames: options.additionalToolNames,
    domainProfile,
    systemContextAddendum,
    logDir: options.logDir,
    logFile: options.logFile,
    maxToolCalls: options.maxToolCalls,
    maxToolsPerTurn: options.maxToolsPerTurn,
    maxToolJsonBytes: options.maxToolJsonBytes,
    maxEvidenceChars: options.maxEvidenceChars,
    maxSessionTurns: options.maxSessionTurns,
    maxSessionChars: options.maxSessionChars,
    requestTimeoutMs: options.requestTimeoutMs,
    temperature: options.temperature,
    topP: options.topP,
    maxTokens: options.maxTokens,
    stderr: (line) => process.stderr.write(`[dkg-mcp] ${line}\n`),
  });
  try {
    const { runtime, trace } = session;

    process.stderr.write(`Interaction log: ${trace.filePath}\n`);
    if (options.prompt) {
      const result = await runtime.run(options.prompt);
      process.stdout.write(`${result.answer}\n`);
    }

    if (options.interactive) {
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const info = runtime.getSessionInfo();
        process.stdout.write(
          `DKG local LLM chat ready (${info.maxTurns} turns / ${info.maxChars} history chars). `
          + 'Use /help for commands.\n',
        );
        while (true) {
          const input = (await terminal.question('> ')).trim();
          if (!input) continue;
          const command = await handleLlmInteractiveCommand(input, runtime, trace.filePath);
          if (command.handled) {
            if (command.output) process.stdout.write(`\n${command.output}\n\n`);
            if (command.exit) break;
            continue;
          }
          try {
            const result = await runtime.run(input);
            process.stdout.write(`\n${result.answer}\n\n`);
          } catch (error) {
            process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      } finally {
        terminal.close();
      }
    }
  } finally {
    await session.close();
  }
}

export function registerLlmCommand(program: Command): void {
  program
    .command('llm')
    .description('Chat with the local DKG through an OpenAI-compatible local model server')
    .argument('[prompt...]', 'one-shot prompt; omit it to start interactive chat')
    .option('-i, --interactive', 'continue into a bounded interactive chat session')
    .option('--llama-url <url>', 'OpenAI-compatible chat-completions endpoint')
    .option('--model <name>', 'model value sent to the local endpoint')
    .option('--project <id>', 'explicitly pin this LLM session to one DKG Context Graph')
    .option('--profile <name>', 'tool profile: auto | chat | status | catalog | read | write', 'auto')
    .option('--allow-write', 'expose relevant mutation tools; still requires explicit mutation intent')
    .option('--adapter <path...>', 'extra MCP adapter module path(s)')
    .option('--tool <name...>', 'additional adapter tool name(s) eligible for routing')
    .option('--system-context-file <path>', 'domain addendum appended to the generic v4.2 context')
    .option('--domain-profile <path>', 'JSON routing/tool/context profile for an MCP adapter domain')
    .option('--log-dir <path>', 'text trace directory (default: <DKG_HOME>/logs/local-llm)')
    .option('--log-file <path>', 'exact text trace file path')
    .option('--max-tool-calls <n>', 'successful tool-call limit per turn', '4')
    .option('--max-tools <n>', 'maximum tool schemas exposed per turn', '8')
    .option('--max-tool-json-bytes <n>', 'maximum serialized tool-schema bytes exposed per turn', '18000')
    .option('--max-evidence-chars <n>', 'tool evidence characters sent back to the model', '12000')
    .option('--session-turns <n>', 'retained interactive turns', '6')
    .option('--session-chars <n>', 'prior-session context character limit', '8000')
    .option('--request-timeout-ms <n>', 'local-model HTTP timeout', '120000')
    .option('--temperature <n>', 'sampling temperature', '0.15')
    .option('--top-p <n>', 'top-p sampling value', '0.9')
    .option('--max-tokens <n>', 'maximum answer tokens', '1024')
    .action(async (prompt: string[], rawOptions: LlmCommandOptions) => {
      const options = resolveLlmCommandOptions(prompt ?? [], rawOptions);
      await runLlmCommand(options);
    });
}
