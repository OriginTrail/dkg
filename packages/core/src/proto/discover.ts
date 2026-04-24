/**
 * Protobuf wire schemas used by this module for encode/decode helpers.
 *
 * The `*Schema` consts below are exported strictly for backwards
 * compatibility with external consumers that deep-imported them
 * before `@origintrail-official/dkg-core` had an `exports` map.
 * They are implementation detail — prefer the `*Msg` types and
 * `encode*` / `decode*` functions re-exported from
 * `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const DiscoverRequestSchema = new Type('DiscoverRequest')
  .add(new Field('type', 1, 'string'))
  .add(new Field('query', 2, 'string'))
  .add(new Field('paranetId', 3, 'string'))
  .add(new Field('limit', 4, 'uint32'));

export const DiscoverResponseSchema = new Type('DiscoverResponse')
  .add(new Field('results', 1, 'bytes'))
  .add(new Field('count', 2, 'uint32'))
  .add(new Field('error', 3, 'string'));

export interface DiscoverRequestMsg {
  type: string;
  query: string;
  paranetId: string;
  limit: number;
}

export interface DiscoverResponseMsg {
  results: Uint8Array;
  count: number;
  error: string;
}

export function encodeDiscoverRequest(msg: DiscoverRequestMsg): Uint8Array {
  return DiscoverRequestSchema.encode(
    DiscoverRequestSchema.create(msg),
  ).finish();
}

export function decodeDiscoverRequest(buf: Uint8Array): DiscoverRequestMsg {
  return DiscoverRequestSchema.decode(buf) as unknown as DiscoverRequestMsg;
}

export function encodeDiscoverResponse(msg: DiscoverResponseMsg): Uint8Array {
  return DiscoverResponseSchema.encode(
    DiscoverResponseSchema.create(msg),
  ).finish();
}

export function decodeDiscoverResponse(buf: Uint8Array): DiscoverResponseMsg {
  return DiscoverResponseSchema.decode(buf) as unknown as DiscoverResponseMsg;
}
