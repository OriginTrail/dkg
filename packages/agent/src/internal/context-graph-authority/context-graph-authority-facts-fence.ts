// SPDX-License-Identifier: Apache-2.0

interface GraphAuthorityFactsSource {
  readContextGraphAuthorityFactsRevision(contextGraphId: string): string;
}

/** Own the comparison for one source-qualified metadata proof. */
export function captureContextGraphAuthorityFactsFence(
  source: GraphAuthorityFactsSource,
  contextGraphId: string,
): Readonly<{ assertCurrent(): boolean }> {
  const revision = source.readContextGraphAuthorityFactsRevision(contextGraphId);
  return Object.freeze({
    assertCurrent: () => source.readContextGraphAuthorityFactsRevision(contextGraphId) === revision,
  });
}
