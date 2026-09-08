import {
  buildEpcisQuery, parseEventsRequest, EpcisQueryValidationError,
  type EpcisEventFilters, type EpcisQueryScope,
} from '@origintrail-official/dkg-epcis';

const filters: EpcisEventFilters = { eventType: 'ObjectEvent', epc: 'urn:item' };
const scope: EpcisQueryScope = { contextGraphId: 'supply-chain', finalized: false, subGraphName: 'events' };
buildEpcisQuery({ ...filters, finalized: scope.finalized, subGraphName: scope.subGraphName, limit: 20 }, scope.contextGraphId);
const request = parseEventsRequest(new URLSearchParams('finalized=false&perPage=20'));
const finalized: boolean = request.finalized;
void finalized;
// @ts-expect-error Event filters do not carry storage routing.
const invalidFilters: EpcisEventFilters = { finalized: false };
void invalidFilters;
try { buildEpcisQuery({ offset: 10001 }, scope.contextGraphId); }
catch (error) {
  if (error instanceof EpcisQueryValidationError) {
    const message: string = error.message;
    void message;
    // @ts-expect-error The public validation error remains transport-neutral.
    void error.statusCode;
  }
}
