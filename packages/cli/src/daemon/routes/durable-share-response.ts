/** Only observation metadata is public; never expose the queue claim or binding. */
export function durableRecoveryDetails(error: any): Record<string, unknown> {
  return error?.recoveryJobId ? { recoveryJobId: error.recoveryJobId,
    recoveryState: error.recoveryState, recoveryStatusUrl: error.recoveryStatusUrl,
    ...(error.recoveryState === 'inspection-required' ? { retryable: false } : {}) } : {};
}

export function partialDurableShareFailure(result: Record<string, unknown>, recovery: Record<string, unknown>, name: string) {
  return { created: true, ...result, ...recovery, partial: true,
    phase: 'swm-share', failedPhase: 'swm-share',
    retryAction: recovery.retryAction ?? 'retry_same_knowledge_asset', retryKnowledgeAssetName: name };
}
