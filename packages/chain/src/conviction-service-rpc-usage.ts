// SPDX-License-Identifier: Apache-2.0

/**
 * The RPC usage consumer labels of Conviction Account service spending
 * (OT-RFC-27): the Hub lookups and the reads of
 * `evm-adapter-conviction-service.ts`. `rpc-usage.ts` adds them to the closed
 * snapshot vocabulary (version 4), so the retained diagnostic reports each by
 * name instead of as `other`. A label the adapter reads under must be listed
 * here; `conviction-service.unit.test.ts` checks the adapter's source.
 */
export const CONVICTION_SERVICE_RPC_USAGE_CONSUMERS = [
  // Hub lookups, resolved on every call.
  'Hub.getContractAddress(ServiceSubscriptions)',
  'Hub.getContractAddress(ConvictionServiceStorage)',
  'Hub.getContractAddress(EpochStorageV8)',

  // ServiceSubscriptions views.
  'serviceSubscriptions.currentWindowAllowance',
  'serviceSubscriptions.emissionSpan',
  'serviceSubscriptions.baseLabelCapacity',
  'serviceSubscriptions.scheduledEmission',

  // ConvictionServiceStorage views.
  'convictionServiceStorage.serviceSpendingEnabledAt',
  'convictionServiceStorage.exactScheduleFrom',
  'convictionServiceStorage.assignmentNonce',
  'convictionServiceStorage.assigneeCount',
  'convictionServiceStorage.assigneeAt',
  'convictionServiceStorage.getAssignment',
  'convictionServiceStorage.getUsage',
  'convictionServiceStorage.isAssignmentActive',
  'convictionServiceStorage.accountServiceLabelTotal',
  'convictionServiceStorage.labelCursor',
  'convictionServiceStorage.accountLabel',
  'convictionServiceStorage.serviceLabel',
  'convictionServiceStorage.subscriptionExists',
  'convictionServiceStorage.getSubscription',
  'convictionServiceStorage.getBuckets',
  'convictionServiceStorage.accountSubscriptionCount',
  'convictionServiceStorage.accountSubscriptionAt',

  // Other contract views the status and labels reads take.
  'publishingConviction.version',
  'parametersStorage.protocolTreasury',
  'epochStorage.getEpochPool',

  // Finding an already funded period's PeriodFunded log.
  'conviction service block search head',
  'conviction service block search',
  'conviction service PeriodFunded log',
] as const;
