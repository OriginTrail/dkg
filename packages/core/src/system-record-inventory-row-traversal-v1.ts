/**
 * Bounded row-producing inventory traversal for reconciliation consumers.
 *
 * This is a dedicated package subpath and intentionally is not part of the
 * compatibility-frozen System Record V1 facade.
 */
export {
  createSystemRecordInventoryRowTraversalV1,
  type SystemRecordInventoryRowTraversalFailureV1,
  type SystemRecordInventoryRowTraversalSliceResultV1,
  type SystemRecordInventoryRowTraversalV1,
} from './system-record-inventory-traversal-v1-internal.js';
