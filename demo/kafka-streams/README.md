# Kafka-Streams Two-Node Demo
Build first with `pnpm run build:runtime:packages`.
Configure both daemon homes with `routePlugins` pointing at the absolute `packages/kafka-plugin/dist/index.js` path and `kafka.contextGraphId` set to `kafka-streams-demo` or your `CG_ID`.
Run with `DKG_HOME=/path/to/node1 NODE2_DKG_HOME=/path/to/node2 node demo/kafka-streams/run.mjs --no-pause`.
For a custom plugin that calls `createKafkaPlugin({ contextGraphId })`, also set `KAFKA_ALLOW_FACTORY_CONTEXT_GRAPH=1`.
