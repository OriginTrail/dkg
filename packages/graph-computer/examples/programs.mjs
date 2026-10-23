// Three example Programs for an existing private graph containing synthetic devices.
// Their behavior is fixed in the source approved by the owner, not supplied at invocation.
export function examples(dataGraph) {
  if (!/^[\w:/.@-]+$/.test(dataGraph)) throw new Error('Use a canonical Context Graph ID');
  const readTool = 'urn:example:tool:sparql-read';
  const writeTool = 'urn:example:tool:asset-create';
  const schema = {
    type: 'object', additionalProperties: false, required: ['bindings'], properties: {
      bindings: { type: 'array', maxItems: 10, items: {
        type: 'object', additionalProperties: false, required: ['device', 'temperatureC'], properties: {
          device: { type: 'string', maxLength: 128 }, temperatureC: { type: 'string', maxLength: 128 },
        },
      } },
    },
  };
  const allDevices = 'SELECT ?device ?temperatureC WHERE { ?device a <urn:example:Device> ; <urn:example:temperatureC> ?temperatureC . } ORDER BY ?device LIMIT 10';
  const oneDevice = 'SELECT ?device ?temperatureC WHERE { VALUES ?device { <urn:example:device:001> } ?device a <urn:example:Device> ; <urn:example:temperatureC> ?temperatureC ; <urn:example:line> <urn:example:line:A> . } LIMIT 1';
  const read = query => `(delegate reader (grant dkg.sparql.read) (call dkg/sparql-read@1 ${JSON.stringify(query)}))`;
  const source = (name, effect) => `(strategy example/${name} (version "1.0.0")
  (scope graph:${dataGraph}) (goal ${name})
  (supervise one-for-one (max-restarts 1) (window-ms 60000) ${effect}))`;
  const permission = outputSchema => ({ toolIri: readTool, layer: 'wm', timeoutMs: 5000, maxResultItems: 10, maxOutputBytes: 16384, outputSchema });
  const asset = {
    quads: [{ subject: 'urn:example:assessment:001', predicate: 'urn:example:status', object: '"checked"' }],
  };
  const restrictedSchema = structuredClone(schema);
  restrictedSchema.properties.bindings.maxItems = 1;
  restrictedSchema.properties.bindings.items.properties.device.enum = ['urn:example:device:001'];
  return [
    { name: 'read-devices', source: source('read-devices', read(allDevices)), requiredTools: [readTool], sparqlRead: permission(schema) },
    { name: 'read-and-record', source: source('read-and-record', `(sequence ${read(oneDevice)}
      (delegate recorder (grant dkg.asset.create) (call dkg/asset-create@1 ${JSON.stringify(JSON.stringify(asset))})))`),
      requiredTools: [readTool, writeTool], sparqlRead: permission(schema), assetCreation: { toolIri: writeTool } },
    { name: 'read-device-subset', source: source('read-device-subset', read(oneDevice)), requiredTools: [readTool], sparqlRead: permission(restrictedSchema) },
  ];
}
