import type { StudioReusableComponent } from '../src/studio-composition.js';
const sha = 'a'.repeat(64);
export const recipe: StudioReusableComponent = {
  schemaVersion: 1,
  name: 'Set greeting',
  workflow: { kaRef: 'urn:demo:nos:studio:original', sourceHash: sha },
  definition: {
    id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'Greeting',
    entryId: 'set',
    nodes: [
      {
        id: 'set',
        componentId: 'edit-fields',
        kaRef: 'urn:nos:component:edit-fields:pin',
        sourceHash: sha,
        params: { fields: { greeting: 'Hello' } },
        x: 10,
        y: 10,
      },
    ],
    edges: [],
  },
  inputs: [
    {
      name: 'fields',
      label: 'Greeting fields',
      required: true,
      spec: { type: 'json', label: 'Fields', default: { greeting: 'Hello' } },
      targets: [{ nodeId: 'set', parameter: 'fields' }],
    },
  ],
  outputs: [{ name: 'result', nodeId: 'set', output: 0 }],
};
