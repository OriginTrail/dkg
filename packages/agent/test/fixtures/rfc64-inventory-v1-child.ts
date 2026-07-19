import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, relative, resolve } from 'node:path';

import {
  INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
  InventoryV1OpenError,
  createInventoryV1TestOpener,
  openInventoryV1,
} from '../../src/rfc64/inventory-v1/open.js';
import {
  type InventoryV1QuarantineBoundary,
} from '../../src/rfc64/inventory-v1/lifecycle-adapter.js';
import { INVENTORY_V1_RELATIVE_PATH } from '../../src/rfc64/inventory-v1/sql.js';

const mode = requiredEnvironment('DKG_RFC64_CHILD_MODE');
const dataDirectory = requiredEnvironment('DKG_RFC64_CHILD_DATA_DIR');

if (mode === 'fault') {
  const targetBoundary = requiredEnvironment(
    'DKG_RFC64_CHILD_BOUNDARY',
  ) as InventoryV1QuarantineBoundary;
  const tracePath = requiredEnvironment('DKG_RFC64_CHILD_TRACE');
  const targetPath = resolve(dataDirectory, INVENTORY_V1_RELATIVE_PATH);
  const openForFault = createInventoryV1TestOpener({
    quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
    boundary: (boundary) => {
      appendFileSync(
        tracePath,
        `${JSON.stringify({ boundary, topology: snapshotTopology(dataDirectory) })}\n`,
      );
      if (boundary !== targetBoundary) return;
      if (process.env.DKG_RFC64_CHILD_PROTECT_EVIDENCE === '1') {
        // Synthetic empty WAL/SHM fixtures are not owned by a live SQLite
        // connection. Make their names stable across forced process teardown;
        // the parent restores the production directory mode before recovery.
        chmodSync(dirname(targetPath), 0o500);
      }
      writeSync(process.stdout.fd, `BOUNDARY:${boundary}\n`);
      // Deliberately pause inside the real lifecycle adapter. The parent must
      // terminate this process with SIGKILL; no JavaScript cleanup runs.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
    closeTarget: (close, reason) => {
      close();
      if (
        process.env.DKG_RFC64_CHILD_SYNTHETIC_FULL_MANIFEST !== undefined
        && reason === 'automatic-schema-quarantine'
      ) {
        const hostile = process.env.DKG_RFC64_CHILD_SYNTHETIC_FULL_MANIFEST === 'hostile';
        writeFileSync(
          `${targetPath}-wal`,
          hostile
            ? Buffer.from('hostile-rfc64-wal-evidence\0\u0001\u0002', 'utf8')
            : Buffer.alloc(0),
        );
        writeFileSync(
          `${targetPath}-shm`,
          hostile
            ? Buffer.from('hostile-rfc64-shm-evidence\0\u0003\u0004', 'utf8')
            : Buffer.alloc(0),
        );
      }
    },
  });
  await openForFault(dataDirectory);
  throw new Error(`fault boundary was not reached: ${targetBoundary}`);
} else if (mode === 'reopen') {
  const foundation = await openInventoryV1(dataDirectory, {
    quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
  });
  foundation.close();
  process.stdout.write('OPEN\n');
} else if (mode === 'contender') {
  const targetPath = resolve(dataDirectory, INVENTORY_V1_RELATIVE_PATH);
  const leasePath = join(dirname(targetPath), 'inventory-v1.lease.sqlite3');
  let directLease = 'OPEN';
  const directLeaseDatabase = new DatabaseSync(leasePath);
  try {
    directLeaseDatabase.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK');
  } catch (error) {
    if ((error as { errcode?: unknown }).errcode === 5) directLease = 'BUSY';
    else throw error;
  } finally {
    directLeaseDatabase.close();
  }
  const target = new DatabaseSync(targetPath);
  let targetTransaction = 'BUSY';
  try {
    target.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK');
    targetTransaction = 'FREE';
  } finally {
    target.close();
  }

  let lease = 'OPEN';
  try {
    const foundation = await openInventoryV1(dataDirectory, {
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
    });
    foundation.close();
  } catch (error) {
    if (error instanceof InventoryV1OpenError && error.code === 'database-busy') {
      lease = 'BUSY';
    } else {
      throw error;
    }
  }
  process.stdout.write(`${JSON.stringify({ directLease, targetTransaction, lease })}\n`);
} else {
  throw new Error(`unsupported RFC-64 inventory child mode: ${mode}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

interface TopologyEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'other';
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly sha256?: string;
}

function snapshotTopology(dataDir: string): TopologyEntry[] {
  const database = resolve(dataDir, INVENTORY_V1_RELATIVE_PATH);
  const root = dirname(database);
  if (!existsSync(root)) return [];
  const entries: TopologyEntry[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    entries.push({
      path: relative(root, path) || '.',
      kind,
      size: stat.size,
      dev: stat.dev,
      ino: stat.ino,
      // POSIX advisory locks are process-associated and closing any extra FD
      // for the same inode can release this process's SQLite lease locks.
      // Never open/hash the live DK6L unit from the observation adapter.
      ...(kind === 'file' && !path.includes('inventory-v1.lease.sqlite3')
        ? { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
        : {}),
    });
    if (kind === 'directory') {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
