// SPDX-License-Identifier: Apache-2.0
import type { ViewSemanticsDeltaSummary } from '@origintrail-official/dkg-query';

interface ReportSource {
  readonly queryEngine: { viewSemanticsDeltaReport(contextGraphIds?: readonly string[]): ViewSemanticsDeltaSummary[] };
  canReadContextGraph(contextGraphId: string, opts: { callerAgentAddress?: string }): Promise<boolean>;
}

/**
 * The semantic-delta summaries of the node's sampled view queries (`DKGQueryEngine`), only for
 * the context graphs this caller may read. A context graph whose read check fails is left out.
 */
export async function readableViewSemanticsDeltaReport(
  agent: ReportSource,
  opts: { readonly contextGraphId?: string; readonly callerAgentAddress?: string } = {},
): Promise<ViewSemanticsDeltaSummary[]> {
  const summaries = agent.queryEngine.viewSemanticsDeltaReport(opts.contextGraphId === undefined ? undefined : [opts.contextGraphId]);
  const readable: ViewSemanticsDeltaSummary[] = [];
  for (const summary of summaries) {
    const allowed = await agent.canReadContextGraph(summary.contextGraphId, { callerAgentAddress: opts.callerAgentAddress })
      .catch(() => false);
    if (allowed) readable.push(summary);
  }
  return readable;
}
