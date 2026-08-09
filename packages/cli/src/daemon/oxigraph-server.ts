/**
 * Public composition boundary for the daemon-managed Oxigraph server.
 *
 * The implementation is split into one serialized supervisor, child-process
 * ownership, listener probes, and the two existing timer slots. This module
 * intentionally owns no lifecycle state itself.
 */
import { createOxigraphServerSupervisorV1 } from './oxigraph-server-supervisor.js';
import type {
  OxigraphServerHandle,
  StartOxigraphServerOptions,
} from './oxigraph-server-contract.js';

export type {
  OxigraphServerHandle,
  OxigraphServerIo,
  OxigraphServerOwnershipV1,
  StartOxigraphServerOptions,
} from './oxigraph-server-contract.js';

/** Spawn, prove, and supervise one local Oxigraph server. */
export async function startOxigraphServer(
  options: StartOxigraphServerOptions,
): Promise<OxigraphServerHandle> {
  return createOxigraphServerSupervisorV1(options);
}
