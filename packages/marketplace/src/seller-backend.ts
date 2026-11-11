// SPDX-License-Identifier: Apache-2.0

/**
 * A seller's backend for one of its services (OT-RFC-27): the connector's calls, whether the last one answered, and
 * what the backend has shown of tools since the node started. The seller makes one per service, and maps what a call
 * comes to onto the wire; this keeps what the backend has shown.
 *   - A call that answers marks the backend up; one with tools that answers shows the backend takes tools.
 *   - A call that fails marks it down, and its error goes to the seller as it came.
 *   - A backend that refuses a buyer's call with tools as made (400 or 422) may refuse its tools, or what that call
 *     put in them. While it has shown nothing of tools, `checkToolsAfter` asks it a minimal call with tools of the
 *     seller's own, with no buyer's content in it, one at a time:
 *       - refused as made too: the backend takes no tools as this service sends them, and the service takes no tool
 *         calls until the node restarts;
 *       - served: the refusal was that call's own, and later refusals are not checked;
 *       - anything else, such as no answer: nothing is known, and the next such refusal checks again.
 *     A buyer's call with tools that answers while a check is out shows the backend takes tools, whatever the check
 *     comes to. A check costs the seller a few tokens, and only until the backend has shown whether it takes tools.
 */
import { UpstreamError, type Completion, type CompletionCall, type Connector } from './connector.js';

/** A backend's statuses that say it cannot take what a call carries: for a call with tools, maybe its tools. */
const CALL_INVALID: ReadonlySet<number> = new Set([400, 422]);

/** The seller's own call with tools, a few tokens long and with no buyer's content in it. */
export const TOOLS_CHECK: Readonly<CompletionCall> = Object.freeze<CompletionCall>({
  messages: [{ role: 'user', content: 'Reply with OK.' }],
  maxTokens: 16,
  tools: [{ type: 'function', function: { name: 'noop', description: 'Does nothing.', parameters: { type: 'object', properties: {} } } }],
});

export class ServiceBackend {
  private answered: 'up' | 'down' = 'up';
  /** What the backend has shown of tools since the node started; nothing is known while it is unset. */
  private tools: 'served' | 'refused' | undefined;
  /** The seller's own call with tools, while one is out. */
  private check: Promise<void> | undefined;

  /**
   * `takesTools` is whether the service's settings say it takes tool calls; `model` names the service in the log.
   */
  constructor(
    private readonly connector: Connector,
    private readonly settings: { model: string; takesTools: boolean },
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

  /** A buyer's call, as the connector answers it. */
  async complete(call: CompletionCall): Promise<Completion> {
    let completion: Completion;
    try {
      completion = await this.connector.complete(call);
    } catch (err) {
      this.answered = 'down';
      throw err;
    }
    this.answered = 'up';
    if (call.tools) this.tools = 'served';
    return completion;
  }

  /**
   * After the backend refused a buyer's call with tools as made with `status`: the check of its tools, for a 400 or
   * a 422 while it has shown nothing of them, or the one already out; nothing for any other. What the backend answers
   * it is kept here, never thrown.
   */
  checkToolsAfter(status: number): Promise<void> {
    if (!CALL_INVALID.has(status) || this.tools !== undefined) return Promise.resolve();
    this.check ??= Promise.resolve()
      .then(() => this.connector.complete(TOOLS_CHECK))
      .then(
        () => { this.tools = 'served'; },
        (err: unknown) => {
          const refused = err instanceof UpstreamError && err.status !== undefined && CALL_INVALID.has(err.status);
          // A buyer's call with tools that answered meanwhile shows the backend takes them.
          if (!refused || this.tools !== undefined) return;
          this.tools = 'refused';
          this.log?.(`[marketplace] ${this.settings.model} takes no tool calls until the node restarts: its backend refused a minimal call with tools too: ${err.message}`);
        },
      )
      .finally(() => { this.check = undefined; });
    return this.check;
  }
}
