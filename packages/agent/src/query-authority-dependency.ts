// SPDX-License-Identifier: Apache-2.0
/** Stop a cancelled caller from starting the next authorization dependency.
 * The dependency receives its signal at the adapter; shared work retains its own lifetime. */
export async function readQueryAuthorityDependency<T>(
  signal: AbortSignal | undefined, dependency: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  try { return await dependency(); }
  finally { signal?.throwIfAborted(); }
}
