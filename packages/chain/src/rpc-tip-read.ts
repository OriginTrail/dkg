// SPDX-License-Identifier: Apache-2.0
import type { JsonRpcProvider } from 'ethers';
import type { ReadOpts } from './rpc-failover-client.js';

/** A background tip probe is preference-transparent: it must neither re-probe nor
 * clear the preferred backend used by foreground reads/writes, and it must see a
 * canonical fresh tip instead of a lagging sticky endpoint. Keep the transport
 * carve-out here so scanners and adapter callers share one policy. */
export function readTip<T>(read: <R>(label: string, fn: (provider: JsonRpcProvider) => Promise<R>, opts?: ReadOpts) => Promise<R>,
  label: string, fn: (provider: JsonRpcProvider) => Promise<T>, opts?: ReadOpts): Promise<T> {
  return read(label, fn, { ...opts, skipPreferred: true });
}
