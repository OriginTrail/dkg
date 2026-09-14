import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveAtomicWriteDestination } from './fs-utils.js';

export interface ConfigWriteLease {
  release(): void;
}

/**
 * SQLite supplies a process-safe file lock without PID reclamation or expiry.
 * The empty sidecar is permanent: unlinking it could split concurrent writers
 * across different inodes. Closing the connection (including process death)
 * releases the lock; the configuration itself remains an atomic JSON file.
 */
export async function acquireConfigWriteLease(configPath: string): Promise<ConfigWriteLease> {
  const destination = await resolveAtomicWriteDestination(configPath);
  await mkdir(dirname(destination), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const path = `${destination}.write-lock.sqlite`;
  const db = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
  } catch (error) {
    db.close();
    const code = (error as { errcode?: number } | null)?.errcode;
    if (code === 5 || code === 6) {
      throw new Error('Configuration is owned by another process. Use daemon settings while it is running, or stop the daemon before changing startup configuration; retry if another CLI write is in progress.', { cause: error });
    }
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      db.close();
      released = true;
    },
  };
}
