import type { ChildProcess } from 'node:child_process';

/**
 * Supervise a writer process the caller spawned with `stdio: ['ignore', 'pipe', 'pipe']`: read its
 * stdout line by line, kill it with SIGKILL `delayMs` after the first line `arm` accepts, and resolve
 * with every line it printed, including the ones that arrived after the kill was armed. Throws when
 * the writer stops by itself, or prints no such line within 120 s.
 */
export async function killWriterOnLine(
  child: ChildProcess,
  arm: (line: string) => boolean,
  delayMs: number,
  what: string,
): Promise<readonly string[]> {
  const lines: string[] = [];
  let output = '';
  let stderr = '';
  let killed = false;
  let timedOut = false;
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      lines.push(line);
      if (!killed && arm(line)) {
        killed = true;
        setTimeout(() => child.kill('SIGKILL'), delayMs);
      }
    }
  });
  try {
    const { code, signal } = await exited;
    if (timedOut) throw new Error(`${what} printed no line to be killed at within 120 s: ${stderr}`);
    if (signal !== 'SIGKILL' || !killed) throw new Error(`${what} stopped by itself (code ${code}, signal ${signal}): ${stderr}`);
  } finally { clearTimeout(deadline); }
  return lines;
}
