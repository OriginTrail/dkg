import type { ChildProcess } from 'node:child_process';
export interface OwnedProcess {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  stop(): Promise<void>;
  ready<T>(probe: (context: { signal: AbortSignal; stdout(): string }) => T | undefined | Promise<T | undefined>, options?: { timeoutMs?: number; intervalMs?: number }): Promise<T>;
  waitForExit(timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}
export function ownProcess(child: ChildProcess, options?: { label?: string; graceMs?: number; killTimeoutMs?: number }): OwnedProcess;
