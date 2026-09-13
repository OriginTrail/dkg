import { AbortableKeyedSingleFlight } from
  '../src/keyed-ttl-single-flight-cache.js';

const numbers = new AbortableKeyedSingleFlight<string, number>();

void numbers.run('chain', async () => 1);

void numbers.run(
  'chain',
  // @ts-expect-error One single-flight instance has one stable value type.
  async () => 'incompatible',
);
