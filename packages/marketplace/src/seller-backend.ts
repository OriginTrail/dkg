// SPDX-License-Identifier: Apache-2.0

/**
 * A seller's backend for one of its services (OT-RFC-27): the connector's calls, whether the last one answered, and
 * what the backend has shown of tools since the node started. The seller makes one per service, and maps what a call
 * comes to onto the wire.
 *   - A call that answers marks the backend up; one with tools that answers shows the backend takes tools.
 *   - A call that fails marks it down, and its error goes to the seller as it came.
 *   - A backend that refuses a buyer's call with tools as made (400 or 422) may refuse its tools, or what that call
 *     put in them. While the backend has shown nothing of tools, it is checked with calls of the seller's own, with
 *     no buyer's content in them (`TOOLS_CHECKS`): a minimal call with tools, and if that is refused as made, the
 *     same call with its function named, which some backends take though they take no automatic choice.
 *       - Either served: the backend takes tools, the refusal was that call's own, and later refusals are not
 *         checked.
 *       - Both refused as made: the backend takes no tools as this service sends them, and the service takes no
 *         tool calls until the node restarts.
 *       - Anything else, such as no answer: nothing is known, and the next such refusal checks again.
 *     One check at a time; a refusal while one is out joins it. The refused call waits for the check
 *     `TOOLS_CHECK_WAIT_MS` at most, and never past its time limit counted from when it went to the backend, so its
 *     answer comes no later than that limit already allowed; the check goes on after that, and what it finds still
 *     counts. A buyer's call with tools that answers while a check is out shows the backend takes tools, whatever
 *     the check comes to. A check costs the seller a few tokens, and only until the backend has shown whether it
 *     takes tools.
 */
import { UpstreamError, type Completion, type CompletionCall, type Connector } from './connector.js';
import type { ToolSpec } from './wire.js';

/** A backend's statuses that say it cannot take what a call carries: for a call with tools, maybe its tools. */
const CALL_INVALID: ReadonlySet<number> = new Set([400, 422]);

/** The longest a refused call with tools waits for the check of its backend's tools. */
export const TOOLS_CHECK_WAIT_MS = 5_000;

/**
 * The checks' function, in the shape tool-taking backends take most widely: one required string parameter, no strict
 * schema. Some backends refuse a function whose parameters have no properties.
 */
const ECHO: ToolSpec = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echoes a word.',
    parameters: { type: 'object', properties: { word: { type: 'string', description: 'The word to echo.' } }, required: ['word'] },
  },
};

/**
 * The seller's own calls with tools, a few tokens long and with no buyer's content in them, in the order they are
 * asked: the model's own choice of tools, then the function named.
 */
export const TOOLS_CHECKS: readonly CompletionCall[] = [
  { messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 16, tools: [ECHO] },
  { messages: [{ role: 'user', content: 'Echo the word OK.' }], maxTokens: 16, tools: [ECHO], tool_choice: { type: 'function', function: { name: 'echo' } } },
];

export interface ServiceBackendSettings {
  /** The service's model, which names it in the log. */
  model: string;
  /** Whether the service's settings say it takes tool calls. */
  takesTools: boolean;
  /** The backend's time limit, in milliseconds: a refused call is answered within it. */
  timeoutMs: number;
}

const refusedAsMade = (err: unknown): err is UpstreamError =>
  err instanceof UpstreamError && err.status !== undefined && CALL_INVALID.has(err.status);

export class ServiceBackend {
  private answered: 'up' | 'down' = 'up';
  /** What the backend has shown of tools since the node started; nothing is known while it is unset. */
  private tools: 'served' | 'refused' | undefined;
  /** The check of the backend's tools, while one is out. */
  private check: Promise<void> | undefined;

  constructor(
    private readonly connector: Connector,
    private readonly settings: ServiceBackendSettings,
    private readonly log?: (message: string) => void,
  ) {}

  /** Whether the backend answered its last call: `up` until one fails. */
  get state(): 'up' | 'down' {
    return this.answered;
  }

  /** Whether the service takes tool calls now: its settings say so, and its backend has not refused them. */
  get takesTools(): boolean {
    return this.settings.takesTools && this.tools !== 'refused';
  }

  /**
   * A buyer's call, as the connector answers it. A call with tools refused as made while nothing is known of the
   * backend's tools waits for their check, within its time limit, and then fails with its own error.
   */
  async complete(call: CompletionCall): Promise<Completion> {
    const sentAt = Date.now();
    let completion: Completion;
    try {
      completion = await this.connector.complete(call);
    } catch (err) {
      this.answered = 'down';
      if (call.tools && refusedAsMade(err) && this.tools === undefined) {
        await within(this.checkTools(), Math.min(TOOLS_CHECK_WAIT_MS, this.settings.timeoutMs - (Date.now() - sentAt)));
      }
      throw err;
    }
    this.answered = 'up';
    if (call.tools) this.tools = 'served';
    return completion;
  }

  /** The check of the backend's tools (the module comment), or the one already out. What it finds is kept, never thrown. */
  private checkTools(): Promise<void> {
    this.check ??= this.runCheck().finally(() => { this.check = undefined; });
    return this.check;
  }

  private async runCheck(): Promise<void> {
    let refusal: UpstreamError | undefined;
    for (const check of TOOLS_CHECKS) {
      // A buyer's call with tools that answered meanwhile shows the backend takes them.
      if (this.tools !== undefined) return;
      try {
        await this.connector.complete(check);
      } catch (err) {
        if (!refusedAsMade(err)) return;
        refusal = err;
        continue;
      }
      this.tools = 'served';
      return;
    }
    if (this.tools !== undefined) return;
    this.tools = 'refused';
    this.log?.(`[marketplace] ${this.settings.model} takes no tool calls until the node restarts: its backend refused minimal calls with tools too: ${refusal!.message}`);
  }
}

/** Wait for `work`, for `ms` at most; it goes on after that, and what it comes to is not this wait's. */
async function within(work: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
