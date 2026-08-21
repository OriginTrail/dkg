import {
  DKGAgent,
  type PublishAsyncAdmission,
  type PublishAsyncOpts,
} from '@origintrail-official/dkg-agent';

// GH#2305 item 1 — admission is a REQUIRED, declared parameter, and this lane is the only place
// that can prove it. The property under test is a compile error, so a runtime test cannot express
// it: every ownership defect in GH#2270 was a caller that OMITTED the principal (the EPCIS capture
// route, then the Kafka stream plugin, both externally authenticated, both silently assigning
// their callers' jobs to the node). A convention cannot prevent an omission; a required parameter
// makes it unrepresentable.

declare const agent: DKGAgent;
declare const content: Record<string, unknown>;

// An authenticated host names its caller.
void agent.publishAsync({ kind: 'agent', agentAddress: '0xabc' }, 'cg', content);
// An internal producer says so on purpose, rather than by staying silent.
void agent.publishAsync({ kind: 'node' }, 'cg', content);

// @ts-expect-error Omitting admission must NOT compile. This is the whole point of the change:
// the old shape accepted `publishAsync(cg, content, opts)` and treated the missing principal as
// "internal producer, use the node default", which is precisely how EPCIS and Kafka each shipped
// with their submitters' jobs owned by the node.
void agent.publishAsync('cg', content);

// @ts-expect-error A bare address is not an admission. The caller must state WHICH kind it is, so
// "I have an authenticated identity" and "there is no authenticated caller" cannot be confused.
void agent.publishAsync('0xabc', 'cg', content);

// @ts-expect-error An unknown discriminant is rejected, so a new admission kind has to be added to
// the union deliberately rather than invented at a call site.
void agent.publishAsync({ kind: 'plugin', agentAddress: '0xabc' }, 'cg', content);

// @ts-expect-error The agent form requires the address; `{ kind: 'agent' }` alone would re-open the
// silent fallback this change closes.
void agent.publishAsync({ kind: 'agent' }, 'cg', content);

// @ts-expect-error Publish options are structurally unable to carry the principal. It used to live
// here, which made object-spread ORDER part of the authorization design and let a client-supplied
// options record name an owner on the Kafka lane.
const leaked: PublishAsyncOpts = { admittedByAgentAddress: '0xabc' };
void leaked;

// The admission type itself is exported, so a host can name it in its own signatures rather than
// re-deriving the shape.
declare const declared: PublishAsyncAdmission;
void declared;
