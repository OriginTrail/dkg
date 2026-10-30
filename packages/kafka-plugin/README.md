# @origintrail-official/kafka-plugin
DKG daemon route plugin for publishing Kafka stream registrations as private-by-default `dkg-streams:KafkaStream` Knowledge Assets. Default mount: `/api/kafka/streams`.

The plugin stores the KafkaStream payload in the private partition by default
so stream names, topic names, bootstrap URLs, and scalar extension fields do
not become public metadata. Discovery endpoints still return registered
streams by joining confirmed KA metadata to the public private-data anchor and
the private payload graph:

- `POST /api/kafka/streams/register` enqueues a private KafkaStream KA.
- `GET /api/kafka/streams` lists readable KafkaStream KAs.
- `GET /api/kafka/streams/:ual` returns the readable KafkaStream KA for a UAL.

## Generic registry and discovery

The same registry can describe streams from independent providers. Devices,
tenants and a business ontology are not prerequisites. In addition to the existing
request fields, registration accepts:

| Field | Meaning |
| --- | --- |
| `clusterId` | Stable source namespace used when enrolling a Kafka consumer. |
| `providerIri` | Optional declared organization/system reference. |
| `schemaIri` | Optional message-schema reference; the plugin does not fetch it. |
| `about` | Up to 64 entity IRIs, for applications, devices, sites or other resources. |

`providerIri`, `schemaIri` and `about` become RDF links, not blank-node objects.
`about` is normalized to a sorted, duplicate-free set. These fields and
`registeredByAgentAddress` are reserved core fields. Extensions that previously
used the new request names must rename their input fields; existing extensions
using other names retain their contract and namespace.

The API stamps `registeredByAgentAddress` from the authenticated requester.
`publisherIri` in an opt-in registry envelope comes from the KA's native
`prov:wasAttributedTo` metadata. These identities can differ under curated
publishing. The declared provider is not a grant of authority or proof of broker
ownership. Private graph/API permission and Kafka broker permission are separate.

`GET /api/kafka/streams` accepts exact `publisher`, `registeredBy`, `provider`,
`about`, `schema` and `dataFormat` filters, plus case-insensitive `q` matching the
name or description (at most 200 characters). Unknown or repeated filter names
are rejected rather than silently ignored. All filters are combined with AND,
applied before pagination, and shared by page selection and `total`. Existing
`limit`/`offset`, graph/subgraph scope, caller authorization and legacy/V2 storage
read paths remain in use.

```text
GET /api/kafka/streams?provider=urn:provider:alpha&about=urn:app:events&limit=20
GET /api/kafka/streams?q=application&includeRegistry=true
GET /api/kafka/streams/<URL-encoded-UAL>?includeRegistry=true
```

Default response shapes are unchanged. `includeRegistry=true` adds a `registry`
property to each returned KA:

```json
{
  "version": 1,
  "ual": "did:dkg:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1",
  "contextGraphId": "stream-catalog",
  "publisherIri": "did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "descriptor": {
    "name": "Application events",
    "kafkaBootstrapUrl": "kafka://broker.example.com:9094",
    "kafkaTopicName": "application.events",
    "kafkaAuthMethod": "SASL_SSL",
    "kafkaSaslMechanism": "SCRAM-SHA-512",
    "dataFormat": "JSON",
    "clusterId": "example-cluster",
    "providerIri": "urn:provider:alpha",
    "registeredByAgentAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "descriptorHash": "sha256:<64 lowercase hexadecimal characters>"
}
```

The hash covers the normalized descriptor, including its optional entity links
and registrar. The envelope also binds the selected graph, UAL and available
publisher attribution. Legacy entries do not acquire an invented registrar.
Malformed or ambiguous descriptors cannot be exported as registry snapshots;
ordinary legacy JSON-LD discovery remains available without the envelope.

Extension contexts support inline string term/prefix aliases and `@vocab` values
that resolve to absolute IRIs. Aliases cannot add core registrar assertions.
Document-wide directives such as `@base`, `@import` and `@language`, and relative
vocabularies, return `400 InvalidContent` before publication is enqueued.

`@origintrail-official/kafka-plugin/registry` exports the shared wire schema,
descriptor normalization, digest and envelope validation without importing the
daemon route handler. The Kafka Source Worker package uses this contract for
[explicit enrollment](../kafka-source/README.md#enroll-a-registered-stream).

Registrations are immutable snapshots selected by UAL. Re-registering a topic
creates another registration; it does not update a running consumer. Registered
and readable means catalog visibility, not broker health, record freshness or
permission to consume. Discovery covers the configured catalog graph; it does
not crawl other nodes or enumerate broker topics.
