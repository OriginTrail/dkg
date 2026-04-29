import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SourceWorkerConfig<TSource = unknown> {
  pollIntervalMs: number;
  stateFile: string;
  daemonUrl: string;
  daemonToken: string;
  handlerModule: string;
  handlerExport?: string;
  sources: TSource[];
}

export async function loadSourceWorkerConfig<TSource = unknown>(configPath: string): Promise<SourceWorkerConfig<TSource>> {
  const resolvedConfigPath = resolve(configPath);
  const raw = await readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(raw) as SourceWorkerConfig<TSource>;
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    throw new Error('Source worker config must define at least one source');
  }
  if (!parsed.handlerModule) {
    throw new Error('Source worker config must define handlerModule');
  }
  return {
    ...parsed,
    pollIntervalMs: parsed.pollIntervalMs > 0 ? parsed.pollIntervalMs : 60000,
    stateFile: resolve(dirname(resolvedConfigPath), parsed.stateFile),
    daemonUrl: parsed.daemonUrl.replace(/\/$/, ''),
    handlerModule: resolve(dirname(resolvedConfigPath), parsed.handlerModule),
  };
}
