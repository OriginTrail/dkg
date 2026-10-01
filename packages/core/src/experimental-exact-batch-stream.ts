/**
 * Opt-in exact-batch transport over the router's existing encrypted libp2p
 * connections. Framing/KA proofs/gzip/verified atomic commits stay agent-owned.
 * No pooled RESPONSE frame, new cipher, default registration or payload replay.
 */
import type { Stream } from '@libp2p/interface';
import { isProtocolUnsupportedError, type ProtocolRouter, type DuplexStreamOptions } from './protocol-router.js';

export const EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL = '/dkg/experimental/exact-batch-stream/1.0.0';
export const EXPERIMENTAL_EXACT_BATCH_STREAM_WINDOW_SIZE = 2;

/** Structural injection prevents a Core -> agent package dependency cycle. */
export interface ExactBatchTransportFrame {
  kind: number;
  assetIndex: number;
  sequence: number;
  payload: Uint8Array;
}

export interface ExactBatchTransportCodec<F extends ExactBatchTransportFrame> {
  encode(frame: F): Uint8Array;
  decode(source: AsyncIterable<Uint8Array>, options: { signal: AbortSignal }): AsyncGenerator<F>;
}

export type ExactBatchTransportFrameKind = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Closed numeric observations; never request text, scope identifiers or peers. */
export type ExactBatchTransportEvent =
  | Readonly<{ event: 'streamReady'; elapsedMs: number }>
  | Readonly<{ event: 'bytes'; direction: 'sent' | 'received'; byteLength: number }>
  | Readonly<{ event: 'frame'; direction: 'sent' | 'received'; frameKind: ExactBatchTransportFrameKind }>;

export interface ExactBatchTransportOptions extends DuplexStreamOptions {
  /** Fixed experimental wire profile; window1 is contract unit-test coverage only. */
  windowSize: 2;
  maxRequestBytes: number;
  maxFrameBytes: number;
  /** Existing effective wire/phase ceiling, not an aggregate buffered batch. */
  maxResponseBytes: number;
  /**
   * Best-effort only. Sent bytes are encoded payload accepted by native send,
   * including a send that subsequently fails drain; sent frame counts follow
   * successful send/drain. Received bytes include a later rejected raw chunk.
   * These exclude Noise, muxer and TCP overhead. Never awaited by transport.
   */
  onTransportEvent?: (event: ExactBatchTransportEvent) => void | Promise<void>;
}

function observe(options: ExactBatchTransportOptions, event: ExactBatchTransportEvent): void {
  if (!options.onTransportEvent) return;
  try {
    const pending = options.onTransportEvent(Object.freeze(event));
    if (pending) void Promise.resolve(pending).catch(() => undefined);
  }
  catch { /* An observer cannot turn a transport outcome into a failure. */ }
}

function observeFrame(options: ExactBatchTransportOptions, direction: 'sent' | 'received', kind: number): void {
  if (!options.onTransportEvent) return;
  if (Number.isInteger(kind) && kind >= 1 && kind <= 7) {
    observe(options, { event: 'frame', direction, frameKind: kind as ExactBatchTransportFrameKind });
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Exact batch stream aborted');
}

function validateLimits(options: ExactBatchTransportOptions): void {
  for (const value of [options.maxRequestBytes, options.maxFrameBytes, options.maxResponseBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Exact batch transport limits must be positive safe integers');
  }
  if (options.maxRequestBytes > 8192 || options.maxFrameBytes > 65536 + 16
    || options.maxReadBufferBytes > options.maxFrameBytes * 2) throw new RangeError('Exact batch transport exceeds experimental wire limits');
  if (options.windowSize !== 2) throw new Error('Experimental exact-batch profile requires window2');
}

function validateAssets(assetUals: readonly string[]): void {
  if (!Array.isArray(assetUals) || assetUals.length < 1 || assetUals.length > 10
    || assetUals.some((ual) => typeof ual !== 'string' || ual.length === 0)
    || new Set(assetUals).size !== assetUals.length) throw new Error('Exact batch requires 1-10 distinct authorized asset UALs');
}

/** Only before START bytes: legacy fallback must never replay an ambiguous request. */
export class ExperimentalExactBatchUnsupportedError extends Error {
  readonly code = 'EXPERIMENTAL_EXACT_BATCH_UNSUPPORTED';
  constructor(cause: unknown) { super('Experimental exact-batch protocol unsupported before START', { cause }); }
}

export class ExactBatchTransportSession<F extends ExactBatchTransportFrame> {
  private readonly frames: AsyncGenerator<F>;
  readonly windowSize = EXPERIMENTAL_EXACT_BATCH_STREAM_WINDOW_SIZE;
  private authorizedAssets?: readonly string[];
  get assetUals(): readonly string[] {
    if (!this.authorizedAssets) throw new Error('Exact batch asset scope has not been authorized');
    return this.authorizedAssets;
  }

  constructor(
    private readonly stream: Stream,
    readonly signal: AbortSignal,
    private readonly codec: ExactBatchTransportCodec<F>,
    private readonly options: ExactBatchTransportOptions,
    assetUals?: readonly string[],
  ) {
    if (assetUals) this.authorizeAssets(assetUals);
    let wireBytes = 0;
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for await (const incoming of stream) {
          checkSignal(signal);
          const length = incoming.byteLength;
          observe(options, { event: 'bytes', direction: 'received', byteLength: length });
          if (length > options.maxResponseBytes - wireBytes) throw new RangeError('Exact batch wire byte limit exceeded');
          wireBytes += length;
          // Preserve one iterator; never end it after reading the START frame.
          for (let offset = 0; offset < length; offset += options.maxFrameBytes) {
            yield incoming.subarray(offset, Math.min(offset + options.maxFrameBytes, length));
          }
        }
      },
    };
    this.frames = codec.decode(source, { signal });
  }

  authorizeAssets(assetUals: readonly string[]): void {
    if (this.authorizedAssets) throw new Error('Exact batch asset scope is already bound');
    validateAssets(assetUals);
    this.authorizedAssets = Object.freeze([...assetUals]);
  }

  async next(): Promise<F | undefined> {
    checkSignal(this.signal);
    const frame = await this.frames.next();
    if (!frame.done) observeFrame(this.options, 'received', frame.value.kind);
    checkSignal(this.signal);
    return frame.done ? undefined : frame.value;
  }

  async send(frame: F): Promise<void> {
    checkSignal(this.signal);
    const frameKind = frame.kind;
    const bytes = this.codec.encode(frame);
    if (bytes.byteLength > this.options.maxFrameBytes) throw new RangeError('Exact batch frame byte limit exceeded');
    if (this.stream.writableNeedsDrain) await this.stream.onDrain({ signal: this.signal });
    checkSignal(this.signal);
    const accepted = this.stream.send(bytes);
    observe(this.options, { event: 'bytes', direction: 'sent', byteLength: bytes.byteLength });
    if (!accepted) await this.stream.onDrain({ signal: this.signal });
    checkSignal(this.signal);
    observeFrame(this.options, 'sent', frameKind);
  }

  async dispose(): Promise<void> {
    // Router must first close/abort the physical stream, unblocking any read.
    await this.frames.return(undefined).catch(() => undefined);
  }
}

/** Client owns REQUEST and subsequent ACKs on the same duplex stream. */
export async function exchangeExperimentalExactBatch<F extends ExactBatchTransportFrame, T>(
  router: ProtocolRouter,
  peerId: string,
  request: F,
  codec: ExactBatchTransportCodec<F>,
  options: ExactBatchTransportOptions & { assetUals: readonly string[] },
  consume: (session: ExactBatchTransportSession<F>) => Promise<T>,
): Promise<T> {
  const enteredAt = performance.now();
  validateLimits(options);
  validateStart(request, options.maxRequestBytes);
  validateAssets(options.assetUals);
  const stableRequest = { ...request, payload: request.payload.slice() } as F;
  const stableOptions = Object.freeze({ ...options, assetUals: Object.freeze([...options.assetUals]) });
  let session: ExactBatchTransportSession<F> | undefined;
  try {
    return await router.withDuplexStream(peerId, EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL, stableOptions,
      async (stream, signal) => {
        session = new ExactBatchTransportSession(stream, signal, codec, stableOptions, stableOptions.assetUals);
        observe(stableOptions, { event: 'streamReady', elapsedMs: performance.now() - enteredAt });
        await session.send(stableRequest);
        return consume(session);
      });
  } catch (error) {
    if (!session && isProtocolUnsupportedError(error)) throw new ExperimentalExactBatchUnsupportedError(error);
    throw error;
  } finally {
    await session?.dispose();
  }
}

/** Explicit responder registration. Authorization precedes any scoped export. */
export function registerExperimentalExactBatchResponder<F extends ExactBatchTransportFrame>(
  router: ProtocolRouter,
  codec: ExactBatchTransportCodec<F>,
  options: ExactBatchTransportOptions,
  authorizeRequest: (request: Uint8Array, peerId: string, signal: AbortSignal) => Promise<readonly string[]>,
  respond: (request: Uint8Array, session: ExactBatchTransportSession<F>, peerId: string) => Promise<void>,
): void {
  validateLimits(options);
  const stableOptions = Object.freeze({ ...options });
  router.registerDuplexStream(EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL,
    async (stream, signal) => {
      const session = new ExactBatchTransportSession(stream, signal, codec, stableOptions);
      try {
        const start = await session.next();
        if (!start) throw new Error('Exact batch START missing');
        validateStart(start, stableOptions.maxRequestBytes);
        return { requestData: start.payload, continuation: session, dispose: () => session.dispose() };
      } catch (error) {
        stream.abort(error instanceof Error ? error : new Error('Exact batch START failed'));
        await session.dispose();
        throw error;
      }
    }, async ({ requestData, peerId, continuation: session, signal }) => {
      const authorizedAssets = await authorizeRequest(requestData, peerId, signal);
      session.authorizeAssets(authorizedAssets);
      checkSignal(signal);
      await respond(requestData, session, peerId);
    }, stableOptions);
}

function validateStart(frame: ExactBatchTransportFrame, limit: number): void {
  if (frame.kind !== 1 || frame.assetIndex !== 255 || frame.sequence !== 0
    || frame.payload.byteLength > limit) throw new Error('Invalid bounded exact-batch START');
}
