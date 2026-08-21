import { createKafkaPlugin } from '../src/index.js';

// The public factory is the contract a consumer actually types against. Narrowing only the
// internal handler option left this compiling, so the guarantee has to be asserted HERE — and a
// runtime test cannot express it, because the property is a compile error.

// A valid publish option is still accepted.
void createKafkaPlugin({ publishOptions: { accessPolicy: 'public' } });

// @ts-expect-error A nonsense option value must be rejected by the public contract. As a loose
// `Record<string, unknown>` this compiled clean and reached the agent unchecked.
void createKafkaPlugin({ publishOptions: { accessPolicy: 42 } });

// @ts-expect-error An option the agent does not define is rejected too, so a typo in plugin
// configuration fails at build time rather than being silently forwarded.
void createKafkaPlugin({ publishOptions: { accessPolicyy: 'public' } });
