# EPCIS event queries

The events endpoint returns document event-list members, including extended
classes. A legacy standalone standard event requires a `dkg:rootEntity` row in
the selected publication metadata graph. Both historical per-token and collapsed
UAL metadata retain that predicate. A standard RDF type alone is insufficient:
orphan rows and nested typed extension resources are excluded. Arbitrary incoming
relationships do not hide a published legacy root. Restoring raw RDF without its
publication metadata does not restore this legacy event identity.

Standard event types use their short names. Extended types are returned as full
IRIs, which can be reused in the `eventType` filter. Historical compact GS1
extension names remain accepted as query filters.

## Pagination limits

The existing offset-based API accepts `offset` and its encoded `nextPageToken`
form up to **10,000**. This bounds the repeated prefix scan caused by OFFSET.
Larger or unsafe offsets receive HTTP 400 before the query executes. Page sizes
remain 1–1,000, with the endpoint default of 30; one internal lookahead row detects
whether another page exists even at the maximum page size.

If another page would require an offset above the ceiling, the endpoint returns
HTTP 400 with `EPCIS pagination limit reached` and guidance to narrow the event or
time filters. It does not silently terminate pagination or issue an unusable
next link. To retrieve a broad history, use smaller `from`/`to` time windows or
other event filters and follow the Link headers within each query. OFFSET does
not provide snapshot consistency during concurrent writes, and the query still
sorts matching events; this ceiling bounds pagination depth, not all store work.
