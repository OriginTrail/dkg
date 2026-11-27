// The marketplace string table's keys are a closed set: a key the table
// lacks, or one renamed there, fails the type check where it is used.
import { copy, type CopyKey } from '../src/ui/marketplace/copy.generated.js';

copy('ctl.retry');
copy('time.in.min', { n: 3 });

// A key built from a template is checked against the table too.
const stop = 'not-due' as 'not-due' | 'base-fee';
copy(`operate.stopped.${stop}`);

// @ts-expect-error A key the table lacks is not a CopyKey.
copy('ctl.no-such-key');

// @ts-expect-error Nor is a key built from any string.
copy(`ctl.${String(Date.now())}`);

// @ts-expect-error A refusal code from the node is a string: refusalKey maps it to a key.
export const fromNode: CopyKey = 'SubscriptionAlreadyFunded';

export const keys: CopyKey[] = ['err.generic', 'err.offline'];
