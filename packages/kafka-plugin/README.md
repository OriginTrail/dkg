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
