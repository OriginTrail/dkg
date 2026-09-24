import type { Connection, DialProtocolOptions, NewStreamOptions } from '@libp2p/interface';

type StreamProgress = Parameters<NonNullable<NewStreamOptions['onProgress']>>[0];
type StreamPolicy = Pick<NewStreamOptions, 'runOnLimitedConnection' | 'negotiateFully' | 'maxOutboundStreams'>;
type ExecuteProbe = (connection: Connection, options: Omit<NewStreamOptions, 'signal'>) => Promise<number>;
const MAX_PENDING_PROBES = 64;
const MAX_PENDING_OBSERVERS = 64;

interface Observer {
  onProgress?: DialProtocolOptions['onProgress'];
  reject: (error: unknown) => void;
  detach: () => void;
}

interface Flight {
  key: string;
  work: Promise<number>;
  monitor: boolean;
  progress: Map<StreamProgress['type'], StreamProgress>;
  observers: Set<Observer>;
}

/** One physical stream per connection; incompatible stream policies queue. */
export class PingProbeCoordinator {
  private readonly pending = new Map<Connection, Flight[]>();

  constructor(private readonly execute: ExecuteProbe) {}

  async monitor(connection: Connection): Promise<number> {
    const flight = this.flight(connection, {});
    flight.monitor = true;
    return flight.work;
  }

  ping(connection: Connection, options: DialProtocolOptions): Promise<number> {
    options.signal?.throwIfAborted();
    const observers = (this.pending.get(connection) ?? []).reduce((count, flight) => count + flight.observers.size, 0);
    if (observers >= MAX_PENDING_OBSERVERS) return Promise.reject(new Error('Too many pending ping observers'));
    const flight = this.flight(connection, options);
    return new Promise<number>((resolve, reject) => {
      const abort = () => {
        observer.detach();
        reject(options.signal?.reason);
      };
      const observer: Observer = {
        onProgress: options.onProgress,
        reject,
        detach: () => {
          flight.observers.delete(observer);
          options.signal?.removeEventListener('abort', abort);
        },
      };
      flight.observers.add(observer);
      options.signal?.addEventListener('abort', abort, { once: true });
      // A caller joining an already-open stream still receives that stream's
      // opening events, after its own connection-opening progress.
      for (const event of flight.progress.values()) this.deliver(flight, observer, event);
      flight.work.then((rtt) => { observer.detach(); resolve(rtt); }, (error) => {
        observer.detach();
        reject(error);
      });
    });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].flatMap((flights) => flights.map(({ work }) => work)));
  }

  private flight(connection: Connection, options: DialProtocolOptions): Flight {
    const policy: StreamPolicy = {
      // Match the standard ping defaults, but retain explicit false overrides.
      runOnLimitedConnection: options.runOnLimitedConnection ?? true,
      negotiateFully: options.negotiateFully ?? true,
      maxOutboundStreams: options.maxOutboundStreams,
    };
    const key = `${policy.runOnLimitedConnection}:${policy.negotiateFully}:${policy.maxOutboundStreams ?? 'default'}`;
    const queue = this.pending.get(connection) ?? [];
    const existing = queue.find((flight) => flight.key === key);
    if (existing !== undefined) return existing;
    if (queue.length >= MAX_PENDING_PROBES) throw new Error('Too many queued ping probes');
    const prior = queue.at(-1)?.work;
    const flight: Flight = { key, monitor: false, progress: new Map(), observers: new Set(), work: Promise.resolve(0) };
    // The previous flight includes remote FIN. Rejections also release the
    // queue so a caller's limited-connection policy cannot strand the monitor.
    flight.work = Promise.resolve(prior).catch(() => {}).then(() => {
      if (!flight.monitor && flight.observers.size === 0) {
        throw new DOMException('Queued ping has no observers', 'AbortError');
      }
      return this.execute(connection, {
        ...policy,
        onProgress: (event) => {
          // libp2p emits opening/opened. Retain at most those two snapshots,
          // even if a transport repeats progress, and bound observer fanout.
          if (flight.progress.size < 2 || flight.progress.has(event.type)) flight.progress.set(event.type, event);
          // Snapshot: a callback may attach a new caller, which receives this
          // event through replay and must not also receive it from this loop.
          for (const observer of Array.from(flight.observers)) this.deliver(flight, observer, event);
        },
      });
    });
    queue.push(flight);
    this.pending.set(connection, queue);
    const clear = () => {
      const index = queue.indexOf(flight);
      if (index !== -1) queue.splice(index, 1);
      if (queue.length === 0 && this.pending.get(connection) === queue) this.pending.delete(connection);
    };
    flight.work.then(clear, clear);
    return flight;
  }

  private deliver(flight: Flight, observer: Observer, event: StreamProgress): void {
    if (!flight.observers.has(observer)) return;
    try {
      observer.onProgress?.(event);
    } catch (error) {
      // A caller callback cannot abort a physical probe used by other callers.
      observer.detach();
      observer.reject(error);
    }
  }
}
