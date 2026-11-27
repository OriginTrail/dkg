const string = (maxLength, minLength = 0) => ({ type: 'string', maxLength, minLength });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const tableProperties = { columns: array(string(64, 1), 8, 1), rows: array(array(string(128), 8, 1), 20, 1) };
export const tableResult = object({ ok: { type: 'boolean' }, columns: array(string(64), 8),
  rows: array(array(string(128), 8), 20), error: string(256) });
export const csvContracts = {
  'csv-parse': { inputSchema: object({ csv: string(2048, 1) }), outputSchema: tableResult },
  'csv-map': { inputSchema: object({ ...tableProperties, mapping: array(object({
    source: { type: 'integer', minimum: 0, maximum: 7 }, target: string(64, 1) }), 8, 1) }), outputSchema: tableResult },
  'google-sheets-export': { inputSchema: object({ ...tableProperties, title: string(80, 1) }),
    outputSchema: object({ spreadsheetId: string(128, 1), spreadsheetUrl: string(512, 1), rowCount: { type: 'integer', minimum: 1, maximum: 20 } }) },
};
export const csvLabels = { 'csv-parse': 'Parse CSV', 'csv-map': 'Map fields', 'google-sheets-export': 'Export to Google Sheets' };

export function csvProgramSource(kind) {
  const validate = kind === 'csv-parse' ? '' : `
  const x = input as { columns: string[]; rows: string[][]; mapping?: { source: number; target: string }[] };
  if (!Array.isArray(x.columns) || !Array.isArray(x.rows) || x.rows.some(row => row.length !== x.columns.length)) throw new Error('Invalid table dimensions');
  const names = ${kind === 'csv-map' ? 'x.mapping!.map(m => m.target)' : 'x.columns'};
  if (names.some((name, i) => !/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) || names.indexOf(name) !== i)) throw new Error('Use unique column names beginning with a letter');
  ${kind === 'csv-map' ? "if (x.mapping!.some(m => m.source >= x.columns.length)) throw new Error('Unknown source column');" : ''}`;
  return `import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';
export function run(input: unknown) {${validate}
  return invoke_tool('urn:dkg:tool:n8n', input);
}`;
}

const set = (name, value, x) => ({ id: name.toLowerCase().replaceAll(' ', '-'), name, type: 'n8n-nodes-base.set', typeVersion: 3.4,
  position: [x, 0], parameters: { mode: 'raw', jsonOutput: value, options: {} } });
function wrap(kind, credential, webhookPath, middle, response) {
  const nodes = [
    { id: 'receive', name: 'Receive input', type: 'n8n-nodes-base.webhook', typeVersion: 2.1,
      position: [0, 0], webhookId: `dkg-${kind}`,
      parameters: { httpMethod: 'POST', path: webhookPath, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
      credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } } },
    ...middle,
    { id: 'respond', name: 'Return result', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4,
      position: [(middle.length + 1) * 250, 0], parameters: { respondWith: 'json', responseBody: response, options: {} } },
  ];
  return { name: `DKG ${csvLabels[kind]} KA PoC`, nodes,
    connections: Object.fromEntries(nodes.slice(0, -1).map((node, i) => [node.name,
      { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] }])),
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true } };
}
export function csvWorkflow(kind, headerCredential, path, googleCredential) {
  if (kind === 'csv-parse') return wrap(kind, headerCredential, path, [
    { id: 'convert-file', name: 'CSV to binary', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1,
      position: [250, 0], parameters: { operation: 'toText', sourceProperty: 'body.input.csv', binaryPropertyName: 'data', options: { fileName: 'input.csv', encoding: 'utf8' } } },
    { id: 'extract-csv', name: 'Extract from CSV', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1.1,
      position: [500, 0], onError: 'continueRegularOutput', alwaysOutputData: true,
      parameters: { operation: 'csv', binaryPropertyName: 'data', options: { headerRow: false, includeEmptyCells: true, enableBOM: true, relaxQuotes: false } } },
  ], `={{ (() => { const items = $input.all(); const columns = items[0]?.json.row ?? []; const rows = items.slice(1).map(item => item.json.row);
    const ok = !items[0]?.json.error && columns.length > 0 && columns.length <= 8 && rows.length > 0 && rows.length <= 20
      && columns.every((c, i) => typeof c === 'string' && c.length > 0 && c.length <= 64 && columns.indexOf(c) === i)
      && rows.every(row => Array.isArray(row) && row.length === columns.length && row.every(c => typeof c === 'string' && c.length <= 128));
    return { executionId: String($execution.id), output: { ok, columns: ok ? columns : [], rows: ok ? rows : [], error: ok ? '' : 'Use a valid CSV with unique headers, 1–8 columns and 1–20 rows (128 characters per cell).' } }; })() }}`);
  if (kind === 'csv-map') return wrap(kind, headerCredential, path, [
    set('Map fields', `={{ { ok: true, columns: $json.body.input.mapping.map(m => m.target),
      rows: $json.body.input.rows.map(row => $json.body.input.mapping.map(m => row[m.source])), error: '' } }}`, 250),
  ], '={{ { executionId: String($execution.id), output: $json } }}');
  if (kind !== 'google-sheets-export') throw new Error('Unknown CSV component');
  const credentials = googleCredential ? { googleSheetsOAuth2Api: googleCredential } : undefined;
  return wrap(kind, headerCredential, path, [
    { id: 'create-sheet', name: 'Create Google Sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
      position: [250, 0], ...(credentials ? { credentials } : {}),
      parameters: { authentication: 'oAuth2', resource: 'spreadsheet', operation: 'create',
        title: '={{ $("Receive input").first().json.body.input.title }}', sheetsUi: { sheetValues: [{ title: 'CSV export' }] }, options: {} } },
    set('Restore rows', '={{ { rows: $("Receive input").first().json.body.input.rows } }}', 500),
    { id: 'split-rows', name: 'Split rows', type: 'n8n-nodes-base.splitOut', typeVersion: 1.1, position: [750, 0],
      parameters: { fieldToSplitOut: 'rows', include: 'noOtherFields', options: { destinationFieldName: 'row' } } },
    set('Name columns', '={{ Object.fromEntries($("Receive input").first().json.body.input.columns.map((name, i) => [name, $json.row[i]])) }}', 1000),
    { id: 'append-rows', name: 'Write Google rows', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7,
      position: [1250, 0], ...(credentials ? { credentials } : {}),
      parameters: { authentication: 'oAuth2', resource: 'sheet', operation: 'append',
        documentId: { __rl: true, mode: 'id', value: '={{ $("Create Google Sheet").first().json.spreadsheetId }}' },
        sheetName: { __rl: true, mode: 'id', value: '={{ String($("Create Google Sheet").first().json.sheets[0].properties.sheetId) }}' },
        columns: { mappingMode: 'autoMapInputData', value: {} }, options: { cellFormat: 'RAW', handlingExtraData: 'insertInNewColumn' } } },
  ], '={{ { executionId: String($execution.id), output: { spreadsheetId: $("Create Google Sheet").first().json.spreadsheetId, spreadsheetUrl: $("Create Google Sheet").first().json.spreadsheetUrl, rowCount: $("Receive input").first().json.body.input.rows.length } } }}');
}
