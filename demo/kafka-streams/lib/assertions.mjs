const CORE_TYPE = 'dkg-streams:KafkaStream';

export function assertKaMatches(ka, { ual, body }) {
  if (!ka || typeof ka !== 'object') {
    throw new Error(`KA payload is not an object: got ${typeof ka}`);
  }
  if (ka['@id'] !== ual) {
    throw new Error(`KA @id mismatch: expected ${ual}, got ${ka['@id']}`);
  }
  const types = Array.isArray(ka['@type']) ? ka['@type'] : [ka['@type']];
  if (!types.includes(CORE_TYPE)) {
    throw new Error(`KA @type mismatch: expected ${CORE_TYPE}, got ${ka['@type']}`);
  }
  if (ka['schema:name'] !== body.name) {
    throw new Error(`KA schema:name mismatch: expected ${body.name}, got ${ka['schema:name']}`);
  }
  if (ka['dkg-streams:kafkaBootstrapUrl'] !== body.kafkaBootstrapUrl) {
    throw new Error(
      `KA dkg-streams:kafkaBootstrapUrl mismatch: expected ${body.kafkaBootstrapUrl}, ` +
        `got ${ka['dkg-streams:kafkaBootstrapUrl']}`,
    );
  }
  if (ka['dkg-streams:kafkaTopicName'] !== body.kafkaTopicName) {
    throw new Error(
      `KA dkg-streams:kafkaTopicName mismatch: expected ${body.kafkaTopicName}, ` +
        `got ${ka['dkg-streams:kafkaTopicName']}`,
    );
  }
}

export function assertListContains(list, ual) {
  if (!list || !Array.isArray(list.items)) {
    throw new Error(`List payload missing items[]: got ${JSON.stringify(list).slice(0, 200)}`);
  }
  const found = list.items.find((it) => it && it['@id'] === ual);
  if (!found) {
    throw new Error(`UAL ${ual} not present in node2 list (${list.items.length} items)`);
  }
}
