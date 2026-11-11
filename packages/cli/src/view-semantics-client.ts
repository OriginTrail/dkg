// SPDX-License-Identifier: Apache-2.0
import type { ViewSemanticsDeltaReportResponse } from './view-semantics-report.js';

/** The daemon's view-semantics endpoints, for `ApiClient.viewSemantics`. */
export function createViewSemanticsClient(get: <T>(path: string) => Promise<T>) {
  return {
    /** The semantic-delta report of sampled view queries; needs a node-level admin token. */
    deltaReport(contextGraphId?: string): Promise<ViewSemanticsDeltaReportResponse> {
      const query = contextGraphId ? `?contextGraphId=${encodeURIComponent(contextGraphId)}` : '';
      return get<ViewSemanticsDeltaReportResponse>(`/api/query/view-semantics-delta${query}`);
    },
  };
}
