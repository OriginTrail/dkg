import fs from 'node:fs/promises';
import path from 'node:path';

export interface InteractionTrace {
  readonly filePath?: string;
  write(section: string, value?: unknown): Promise<void>;
}

const SECRET_KEY = /(?:authorization|api[-_]?key|cookie|password|secret|token)$/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value.replace(BEARER_VALUE, 'Bearer [REDACTED]');
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(child, seen),
    ]),
  );
}

function render(value: unknown): string {
  if (value === undefined) return '';
  const redacted = redactSecrets(value);
  return typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2);
}

export class TextInteractionTrace implements InteractionTrace {
  readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async create(options: { logDir?: string; logFile?: string } = {}): Promise<TextInteractionTrace> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = options.logFile
      ? path.resolve(options.logFile)
      : path.resolve(options.logDir ?? 'logs/dkg-local-llm', `${timestamp}.log`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `DKG LOCAL LLM INTERACTION TRACE\nStarted: ${new Date().toISOString()}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await fs.chmod(filePath, 0o600);
    return new TextInteractionTrace(filePath);
  }

  async write(section: string, value?: unknown): Promise<void> {
    const block = `\n===== ${section} =====\n${render(value)}\n`;
    this.pending = this.pending.then(() => fs.appendFile(this.filePath, block, 'utf8'));
    await this.pending;
  }
}

export const NOOP_TRACE: InteractionTrace = {
  async write() {
    // Library consumers opt in to persistence by providing a trace.
  },
};
