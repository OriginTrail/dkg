import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticTypeScriptGrant } from './program-policy.js';

export interface CompiledTypeScriptProgram { directory: string; hash: string; manifest: string; source: string }
type Effect = { id: number } & ({ kind: 'program'; program: string; args: unknown[] } | { kind: 'tool'; tool: string; input: unknown });

/** Trusted compiler output only. Raw JS/Wasm artifacts are never accepted from callers. */
export class TypeScriptProgramHost {
  constructor(private readonly options: { compileTimeoutMs?: number } = {}) {}
  private cache = new Map<string, Promise<CompiledTypeScriptProgram>>();
  private directories = new Set<string>();
  private ready = new Map<string, CompiledTypeScriptProgram>();
  private activeDirectories = new Map<string, number>();
  private cancellations = new Set<() => void>();
  private compiling = 0;
  private running = 0;
  private stopped = false;

  async compile(source: string): Promise<CompiledTypeScriptProgram> {
    if (this.stopped) throw new Error('TYPESCRIPT_HOST_STOPPED');
    if (typeof source !== 'string' || Buffer.byteLength(source) > 262144) throw new Error('TYPESCRIPT_SOURCE_TOO_LARGE');
    const key = createHash('sha256').update(source).digest('hex');
    const existing = this.cache.get(key);
    if (existing) { this.cache.delete(key); this.cache.set(key, existing); return existing; }
    if (this.compiling >= 2) throw new Error('TYPESCRIPT_COMPILER_CAPACITY');
    if (this.cache.size >= 32) {
      const expired = [...this.cache.keys()].find(key => {
        const artifact = this.ready.get(key);
        return artifact && !this.activeDirectories.has(artifact.directory);
      });
      if (!expired) throw new Error('TYPESCRIPT_COMPILER_CAPACITY');
      const artifact = this.ready.get(expired)!;
      this.cache.delete(expired); this.ready.delete(expired); this.directories.delete(artifact.directory);
      await rm(artifact.directory, { recursive: true, force: true });
      // Another request may have filled the slot during filesystem cleanup.
      return this.compile(source);
    }
    const work = this.compileNew(source);
    this.cache.set(key, work);
    try { const result = await work; this.ready.set(key, result); return result; }
    catch (error) { this.cache.delete(key); throw error; }
  }

  private async compileNew(source: string): Promise<CompiledTypeScriptProgram> {
    this.compiling++;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'dkg-typescript-'));
      this.directories.add(directory);
      const artifactDirectory = directory;
      if (this.stopped) throw new Error('TYPESCRIPT_HOST_STOPPED');
      return await new Promise((resolve, reject) => {
        const child = this.child('compiler.mjs', 512);
        const finish = this.lifecycle(child, Math.max(100, Math.min(30000, this.options.compileTimeoutMs ?? 30000)), reject);
        child.on('message', (message: any) => {
          if (!finish()) return;
          if (message.ok === true && typeof message.manifest === 'string' && message.manifest.length < 65536
            && createHash('sha256').update(message.manifest).digest('hex') === message.hash)
            resolve({ directory: artifactDirectory, hash: message.hash, manifest: message.manifest, source });
          else reject(new Error(`TYPESCRIPT_COMPILATION_FAILED: ${String(message.error).slice(0, 2048)}`));
        });
        child.send({ source, directory });
      });
    } catch (error) {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
        this.directories.delete(directory);
      }
      throw error;
    } finally { this.compiling--; }
  }

  async execute(artifact: CompiledTypeScriptProgram, inputs: string, grant: SemanticTypeScriptGrant,
    dispatch: (effect: Effect) => Promise<unknown>): Promise<string> {
    if (this.stopped) throw new Error('TYPESCRIPT_HOST_STOPPED');
    if (!this.directories.has(artifact.directory)) return this.execute(await this.compile(artifact.source), inputs, grant, dispatch);
    if (this.running >= 16) throw new Error('TYPESCRIPT_EXECUTION_CAPACITY');
    this.running++;
    this.activeDirectories.set(artifact.directory, (this.activeDirectories.get(artifact.directory) ?? 0) + 1);
    try {
      return await new Promise((resolve, reject) => {
        const child = this.child('worker.mjs', 128);
        let done = false;
        const finish = this.lifecycle(child, grant.timeoutMs, error => { done = true; reject(error); });
        const pending = new Set<number>(), seen = new Set<number>();
        child.on('message', (message: any) => {
          if (done) return;
          try {
            if (message.type !== 'state' || typeof message.state !== 'string' || Buffer.byteLength(message.state) > 262144)
              throw new Error(message.error ?? 'Invalid TypeScript worker response');
            const state = JSON.parse(message.state);
            if (message.completedId !== undefined) {
              if (!pending.delete(message.completedId)) throw new Error('Unknown completion acknowledgement');
            }
            if (!Array.isArray(state.effects)) throw new Error('Invalid effect list');
            if (state.terminal) {
              if (pending.size || state.effects.length) throw new Error('Program returned with unawaited calls');
              if (!state.terminal.ok) throw new Error(state.terminal.error);
              const result = JSON.stringify(state.terminal.value);
              if (result === undefined || Buffer.byteLength(result) > 262144) throw new Error('Program must return bounded JSON');
              done = true;
              if (finish()) resolve(result);
              return;
            }
            if (pending.size + state.effects.length > grant.maxConcurrency || seen.size + state.effects.length > grant.maxCalls)
              throw new Error('TYPESCRIPT_CALL_BUDGET_EXCEEDED');
            for (const effect of state.effects as Effect[]) {
              if (!Number.isSafeInteger(effect.id) || effect.id < 1 || seen.has(effect.id)
                || !['program', 'tool'].includes(effect.kind)) throw new Error('Invalid Program effect');
              const target = effect.kind === 'program' ? effect.program : effect.tool;
              const input = effect.kind === 'program' ? effect.args : effect.input;
              if (typeof target !== 'string' || target.length > 2048 || !/^[a-z][a-z0-9+.-]*:/i.test(target)
                || (effect.kind === 'program' && !Array.isArray(input))
                || input === undefined || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('Invalid Program effect');
              seen.add(effect.id);
              pending.add(effect.id);
              void Promise.resolve().then(() => {
                if (done) throw new Error('Execution stopped');
                return dispatch(effect);
              }).then(
                value => ({ ok: true, value }), error => ({ ok: false, error: String(error).slice(0, 2048) }),
              ).then(result => {
                if (done || !child.connected) return;
                const json = JSON.stringify(result);
                if (Buffer.byteLength(json) > 262144) throw new Error('Child output exceeds 256 KiB');
                child.send({ type: 'settle', id: effect.id, result: json });
              }).catch(error => { done = true; if (finish()) reject(error); });
            }
            if (!pending.size && !state.effects.length) throw new Error('TYPESCRIPT_EXECUTION_STALLED');
          } catch (error) { done = true; if (finish()) reject(error); }
        });
        child.send({ type: 'start', directory: artifact.directory, inputs });
      });
    } finally {
      this.running--;
      const count = this.activeDirectories.get(artifact.directory)! - 1;
      if (count) this.activeDirectories.set(artifact.directory, count); else this.activeDirectories.delete(artifact.directory);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const cancel of [...this.cancellations]) cancel();
    await Promise.allSettled([...this.cache.values()]);
    await Promise.all([...this.directories].map(directory => rm(directory, { recursive: true, force: true })));
    this.cache.clear();
    this.ready.clear();
    this.directories.clear();
  }

  private child(filename: string, heapMb: number): ChildProcess {
    return fork(new URL(`../typescript-runtime/${filename}`, import.meta.url), [], {
      detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [`--max-old-space-size=${heapMb}`], env: { PATH: process.env.PATH ?? '' },
    });
  }

  private lifecycle(child: ChildProcess, timeout: number, reject: (error: Error) => void): () => boolean {
    let complete = false;
    const finish = () => {
      if (complete) return false;
      complete = true;
      clearTimeout(timer);
      this.cancellations.delete(cancel);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
      return true;
    };
    const cancel = () => { if (finish()) reject(new Error('TYPESCRIPT_EXECUTION_STOPPED')); };
    const timer = setTimeout(() => { if (finish()) reject(new Error('TYPESCRIPT_EXECUTION_TIMEOUT')); }, timeout);
    this.cancellations.add(cancel);
    child.on('error', error => { if (finish()) reject(error); });
    child.on('exit', code => { if (finish()) reject(new Error(`TYPESCRIPT_WORKER_EXITED: ${code}`)); });
    return finish;
  }
}
