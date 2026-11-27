import type { Digest32V1, EvmAddressV1, SwmAuthorInventoryRowV1 } from '@origintrail-official/dkg-core';
import {
  createRfc64SwmAuthorInventoryOperationsViewV1,
  type Rfc64SwmAuthorInventoryOperationsV1,
} from '../src/rfc64/inventory-v1/candidate.js';
import type { Rfc64SwmAuthorInventoryOperationsV1 as OwnedOperations } from '../src/rfc64/inventory-v1/swm-author-inventory-contracts.js';

declare const operations: Rfc64SwmAuthorInventoryOperationsV1;
declare const scope: Digest32V1;
declare const author: EvmAddressV1;
declare const kaUal: SwmAuthorInventoryRowV1['kaUal'];
const historicalContract: OwnedOperations = operations;
const view = createRfc64SwmAuthorInventoryOperationsViewV1(historicalContract, () => {});
const row: Readonly<SwmAuthorInventoryRowV1> | null = view.readSwmAuthorInventoryRowV1(scope, author, kaUal);
// A local indexed hint can be absent; it cannot certify whole-inventory completeness.
// @ts-expect-error absence must be handled before accessing an assertion
const assertion = row.assertionCoordinate;
if (row !== null) {
  // @ts-expect-error callers cannot mutate persistence-owned canonical row evidence
  row.assertionVersion = '2';
}
void assertion;
