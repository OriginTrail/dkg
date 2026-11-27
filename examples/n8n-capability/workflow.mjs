/** Credential references are supplied locally; this template contains no secrets. */
export function normalizeWorkflow(credential, webhookPath) {
  return {
    name: 'DKG Normalize text KA PoC',
    nodes: [
      { id: 'receive', name: 'Receive input', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
        position: [0, 0], webhookId: 'dkg-normalize-text-poc',
        parameters: { httpMethod: 'POST', path: webhookPath, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
        credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } } },
      { id: 'normalize', name: 'Normalize text', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [250, 0],
        parameters: { assignments: { assignments: [{ id: 'text', name: 'text', type: 'string',
          value: '={{ $json.body.input.text.trim().toUpperCase() }}' }] }, options: {} } },
      { id: 'respond', name: 'Return result', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [500, 0],
        parameters: { respondWith: 'json', responseBody: '={{ { executionId: String($execution.id), output: { text: $json.text } } }}', options: {} } },
    ],
    connections: {
      'Receive input': { main: [[{ node: 'Normalize text', type: 'main', index: 0 }]] },
      'Normalize text': { main: [[{ node: 'Return result', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true },
  };
}

export const textSchema = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: { text: { type: 'string', maxLength: 256 } },
};

export const programSource = `import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';
export function run(input: { text: string }) {
  return invoke_tool('urn:dkg:tool:n8n', input);
}`;
