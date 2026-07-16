# ADR 0006 — KafkaStream KAs publish private by default

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** DKG core maintainers, DMAAST/customer privacy review
- **Supersedes:** ADR 0005
- **Affected modules:** `packages/kafka-plugin/src/handler.ts`,
  `packages/kafka-plugin/src/discovery.ts`,
  `packages/kafka-plugin/README.md`, `demo/kafka-streams/run.mjs`,
  `packages/kafka-plugin/test/*`

## Context

The original kafka-plugin design treated Stream Registrations as public
catalogue entries: public KA metadata made cross-fork discovery simple via
`?s a dkg-streams:KafkaStream`.

That assumption is unsafe for customer deployments. A Kafka stream name,
topic, bootstrap URL, tenant reference, source reference, or extension
field can reveal private project information even when the actual Kafka
messages remain protected by Kafka auth.

EPCIS already defaults bare capture bodies to `{ private: document }`.
Kafka should follow the same privacy posture unless a caller explicitly
opts into a public catalogue entry.

## Decision

Kafka Stream Registrations publish to the private partition by default.

The plugin may still support an explicit public mode later, but public
must be opt-in and documented as a visibility decision, not the default.
Discovery must read both legacy public payloads and private-default
payloads. Private-default payload discovery joins the public
`dkg:privateDataAnchor` marker to the corresponding private payload
graph, then decrypts private literal bindings before reconstructing the
API JSON-LD response.

Extension fields inherit the same visibility as the base KA. Extensions
must not be used as a backdoor for customer/project-readable metadata in
public KAs.

## Consequences

- Customer deployments do not accidentally leak project, tenant, source,
  site, or stream catalogue details.
- Cross-node public discovery is no longer the default behaviour. Any
  public discovery use case must opt into public visibility explicitly.
- Existing public KafkaStream registrations remain readable through the
  legacy public-payload query branch.
- Tests must cover the privacy envelope and the readback path together;
  changing only the publish envelope can make `GET /` and `GET /:ual`
  return empty results.

## References

- Superseded decision: `.ai/adr/0005-kafka-stream-public-partition.md`
- EPCIS default-private precedent: `packages/epcis/src/handlers.ts`
- Agent default visibility: `packages/agent/src/dkg-agent-utils.ts`
