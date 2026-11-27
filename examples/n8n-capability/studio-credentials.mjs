import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const oauthKinds = ['googleSheetsOAuth2Api', 'googleDriveOAuth2Api'];
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const validReference = ref => ref && typeof ref.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(ref.id)
  && typeof ref.name === 'string' && ref.name.trim() && ref.name.length <= 128;

/** Local operator pins only: unrelated native workflows never select connections. */
export function loadStudioCredentials(state, { fixture = false } = {}) {
  if (fixture) {
    const headerCredential = { id: 'component-fixture-header', name: 'Component fixture' };
    return { headerCredential, credentials: { httpHeaderAuth: headerCredential } };
  }
  const { grant } = readJson(join(state, 'n8n.json'));
  if (typeof grant?.workflowId !== 'string') throw new Error('The configured bootstrap workflow is required.');
  const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT nodes,connections,settings FROM workflow_entity WHERE id=?').get(grant.workflowId);
    if (!row) throw new Error('The configured bootstrap workflow was not found.');
    const workflow = { nodes: JSON.parse(row.nodes), connections: JSON.parse(row.connections), settings: row.settings ? JSON.parse(row.settings) : {} };
    if (n8nWorkflowSha256(workflow) !== grant.workflowSha256) throw new Error('The configured bootstrap workflow revision changed.');
    const webhooks = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.webhook');
    if (webhooks.length !== 1 || webhooks[0].parameters?.authentication !== 'headerAuth')
      throw new Error('The bootstrap workflow must select one authenticated webhook credential.');
    const verify = (kind, ref) => {
      if (!validReference(ref) || db.prepare('SELECT type FROM credentials_entity WHERE id=?').get(ref.id)?.type !== kind)
        throw new Error('The configured ' + kind + ' credential reference is missing or invalid.');
      return { id: ref.id, name: ref.name };
    };
    const headerCredential = verify('httpHeaderAuth', webhooks[0].credentials?.httpHeaderAuth);
    const file = join(state, 'studio-connections.json');
    let selected = {};
    if (existsSync(file)) {
      selected = readJson(file);
      if (!selected || Array.isArray(selected) || typeof selected !== 'object' || Object.keys(selected).some(key => !oauthKinds.includes(key)))
        throw new Error('studio-connections.json must contain explicit Google OAuth credential references.');
    } else {
      // setup-csv records the credential ID explicitly supplied by the operator.
      const csvFile = join(state, 'csv-components.json');
      const ids = existsSync(csvFile) ? [...new Set(readJson(csvFile).components
        .filter(item => item.kind === 'google-sheets-export' && item.enabled).map(item => item.googleCredentialId))] : [];
      if (ids.length > 1) throw new Error('Ambiguous Google Sheets connection. Select it in studio-connections.json.');
      if (ids.length) selected.googleSheetsOAuth2Api = { id: ids[0], name: 'Google Sheets OAuth connection' };
    }
    const credentials = { httpHeaderAuth: headerCredential };
    for (const kind of oauthKinds) if (Object.hasOwn(selected, kind)) credentials[kind] = verify(kind, selected[kind]);
    return { headerCredential, credentials };
  } finally { db.close(); }
}
