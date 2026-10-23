import { lifecycleMaterializationWire, lifecycleRepairCoordinatesWire, type LifecycleRepairEntry } from '../../src/named-ka-vm-lifecycle-repair-journal.js';

/** Historical inline v3 fixture; production writes compact v4 only. */
export function historicalLifecycleRepairJournal(entries: ReadonlyMap<string, LifecycleRepairEntry>) {
  return { version: 3, entries: [...entries].map(([key, entry]) => {
    const { retention: _retention, preparedSnapshot: _preparedSnapshot, input, ...retry } = entry;
    const { materialization } = input;
    return [key, { ...retry, input: { ...lifecycleRepairCoordinatesWire(input),
      ...(materialization ? { materialization: lifecycleMaterializationWire(materialization) } : {}) } }] as const;
  }) };
}
