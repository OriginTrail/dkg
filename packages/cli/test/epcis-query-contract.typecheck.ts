import {
  createEpcisQueryPlan, resolveEpcisQueryWindow, parseEventsRequest, EpcisQueryValidationError,
  type EpcisEventFilters, type EpcisQueryScope, type QueryEngine,
} from '@origintrail-official/dkg-epcis';

const filters: EpcisEventFilters = { eventType: 'ObjectEvent', epc: 'urn:item' };
const scope: EpcisQueryScope = { contextGraphId: 'supply-chain', finalized: false, subGraphName: 'events' };
const plan = createEpcisQueryPlan(filters, scope, resolveEpcisQueryWindow({ limit: 20 }));
const execute = (engine: QueryEngine) => engine.query(plan.sparql, plan.options);
void execute;
const request = parseEventsRequest(new URLSearchParams('finalized=false&perPage=20'));
const finalized: boolean = request.finalized;
void finalized;
// @ts-expect-error Event filters do not carry storage routing.
const invalidFilters: EpcisEventFilters = { finalized: false };
void invalidFilters;
createEpcisQueryPlan(request.filters, { ...scope, finalized: request.finalized },
  resolveEpcisQueryWindow({ limit: request.page.perPage, offset: request.page.offset }));
try { createEpcisQueryPlan(filters, scope, { limit: 20, offset: 10001 }); }
catch (error) {
  if (error instanceof EpcisQueryValidationError) {
    const message: string = error.message;
    void message;
    // @ts-expect-error The public validation error remains transport-neutral.
    void error.statusCode;
  }
}
