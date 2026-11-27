import {
  EXACT_BATCH_FRAME_KIND, EXACT_BATCH_BATCH_INDEX, encodeExactBatchFrame,
  decodeExactBatchFrames, exchangeExperimentalExactBatch, registerExperimentalExactBatchResponder,
  type ExactBatchFrame, type ExactBatchTransportSession, type ExactBatchTransportOptions, type ProtocolRouter,
} from '@origintrail-official/dkg-core';

declare const router: ProtocolRouter;
declare const options: ExactBatchTransportOptions;
declare const session: ExactBatchTransportSession;
const request: ExactBatchFrame = {
  kind: EXACT_BATCH_FRAME_KIND.REQUEST, assetIndex: EXACT_BATCH_BATCH_INDEX,
  sequence: 0, payload: new Uint8Array([1]),
};
const encoded: Uint8Array = encodeExactBatchFrame(request);
const decoded: AsyncGenerator<ExactBatchFrame> = decodeExactBatchFrames((async function* () { yield encoded; })());
void decoded;
const response: Promise<ExactBatchFrame | undefined> = exchangeExperimentalExactBatch(router, 'peer', request,
  { ...options, assetUals: ['asset'] }, (current: ExactBatchTransportSession) => current.next());
void response;
const authorizedContext = { operationId: 'operation', scope: Symbol('scope') };
registerExperimentalExactBatchResponder(router, options,
  async () => ({ assetUals: ['asset'], context: authorizedContext }),
  async (context, current) => {
    const operationId: string = context.operationId;
    const scope: symbol = context.scope;
    void operationId; void scope;
    // @ts-expect-error Core preserves the caller's context type.
    const bytes: Uint8Array = context;
    void bytes;
    await current.send(request);
  });
const window: 2 = session.windowSize;
void window;
// @ts-expect-error The fixed wire session has no caller-selected frame type.
export type GenericSession = ExactBatchTransportSession<ExactBatchFrame>;
// @ts-expect-error The fixed wire transport accepts no injected codec argument.
exchangeExperimentalExactBatch(router, 'peer', request, { encode: encodeExactBatchFrame, decode: decodeExactBatchFrames }, { ...options, assetUals: ['asset'] }, (current: ExactBatchTransportSession) => current.next());
