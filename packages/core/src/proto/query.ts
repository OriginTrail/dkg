/**
 * RESERVED FOR PART 2 — NOT ACTIVE IN PART 1.
 *
 * Store Isolation (Spec §1.6): No node may execute SPARQL against another
 * node's store. This schema is kept as a placeholder for Part 2's constrained
 * cross-node data retrieval (which will NOT pass raw SPARQL — it will be
 * replaced with a constrained entity-lookup schema). Do not register a handler
 * for /dkg/query/1.0.0 in Part 1.
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

const QueryRequestSchema = new Type('QueryRequest')
  .add(new Field('sparql', 1, 'string'))
  .add(new Field('paranetId', 2, 'string'))
  .add(new Field('timeout', 3, 'uint32'));

const QueryResponseSchema = new Type('QueryResponse')
  .add(new Field('nquads', 1, 'bytes'))
  .add(new Field('bindings', 2, 'bytes'))
  .add(new Field('error', 3, 'string'));

export interface QueryRequestMsg {
  sparql: string;
  paranetId: string;
  timeout: number;
}

export interface QueryResponseMsg {
  nquads: Uint8Array;
  bindings: Uint8Array;
  error: string;
}

export function encodeQueryRequest(msg: QueryRequestMsg): Uint8Array {
  return QueryRequestSchema.encode(
    QueryRequestSchema.create(msg),
  ).finish();
}

export function decodeQueryRequest(buf: Uint8Array): QueryRequestMsg {
  return QueryRequestSchema.decode(buf) as unknown as QueryRequestMsg;
}

export function encodeQueryResponse(msg: QueryResponseMsg): Uint8Array {
  return QueryResponseSchema.encode(
    QueryResponseSchema.create(msg),
  ).finish();
}

export function decodeQueryResponse(buf: Uint8Array): QueryResponseMsg {
  return QueryResponseSchema.decode(buf) as unknown as QueryResponseMsg;
}
