import type { QueryOptions } from '@origintrail-official/dkg-storage';

/**
 * The first store mutation may be cancelled. Once it starts, later writes
 * must finish with no deadline signal, even if that first adapter ignores an
 * abort and commits after the caller has already received a decline.
 */
export class ACKCommitSequence {
  private mutationStarted = false;

  constructor(private readonly signal?: AbortSignal) {}

  async write<T>(
    source: string,
    operation: (options: QueryOptions) => Promise<T>,
    didMutate: (result: T) => boolean = () => true,
  ): Promise<T> {
    if (!this.mutationStarted) this.signal?.throwIfAborted();
    const options: QueryOptions = {
      priority: 'ack',
      source,
      ...(!this.mutationStarted && this.signal ? { signal: this.signal } : {}),
    };
    const result = await operation(options);
    if (didMutate(result)) this.mutationStarted = true;
    return result;
  }
}
