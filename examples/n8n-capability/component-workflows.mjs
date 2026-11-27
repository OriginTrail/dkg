import { defaultComponentRegistry, componentExecutionDescriptor, componentValidationSource } from './component-registry.mjs';
import { resolveComponentValueSource } from './guest-sources/component-v2.mjs';

export const nativeVersions = { set: 3.4, filter: 2.3, sort: 1, limit: 1, removeDuplicates: 2, splitOut: 1.1,
  aggregate: 1, summarize: 1.1, renameKeys: 1, dateTime: 2, extractFromFile: 1.1, convertToFile: 1.1,
  xml: 1, html: 1.2, markdown: 1, crypto: 2, compression: 1.1, httpRequest: 4.3, googleSheets: 4.7,
  googleDrive: 3, if: 2.3, switch: 3.4, merge: 3.2, compareDatasets: 2.3, splitInBatches: 3,
  executeWorkflow: 1.4, stopAndError: 1, webhook: 2.1, scheduleTrigger: 1.3, wait: 1.1 };
export const expression = value => `={{ ${value} }}`;
/** Tournament splits on closing template braces even inside string literals. */
export const nativeLiteral = value => 'JSON.parse(' + JSON.stringify(JSON.stringify(value)).replaceAll('{', '\\u007b').replaceAll('}', '\\u007d') + ')';
export const nativeNode = (name, type, parameters = {}, extra = {}) => ({ id: name.replace(/[^a-zA-Z0-9_-]/g, '-'), name,
  type: `n8n-nodes-base.${type}`, typeVersion: nativeVersions[type], position: [500, 0], parameters, ...extra });
export const editNode = (name, value) => nativeNode(name, 'set', { mode: 'raw', jsonOutput: expression(value), options: {} });
export function wire(connections, from, to, output = 0, input = 0) {
  const outputs = (connections[from] ??= { main: [] }).main;
  while (outputs.length <= output) outputs.push([]);
  outputs[output].push({ node: to, type: 'main', index: input });
}

const singlePiece = (node, outputs = 1) => ({ nodes: [node], connections: {}, entry: node.name,
  exits: Array(outputs).fill(node.name), resultNode: node.name });

function withFileInput(piece, name) {
  const input = nativeNode(name + ' file input', 'convertToFile', { operation: 'toBinary', sourceProperty: 'file.base64', binaryPropertyName: 'data',
    options: { fileName: expression('$json.file.name'), mimeType: expression('$json.file.mimeType || "application/octet-stream"') } });
  const connections = { ...piece.connections };
  wire(connections, input.name, piece.entry);
  return { ...piece, nodes: [input, ...piece.nodes], connections, entry: input.name };
}

function withFileOutput(piece, name, param) {
  const output = nativeNode(name + ' file output', 'extractFromFile', { operation: 'binaryToPropery', binaryPropertyName: 'data', destinationKey: 'file.base64', options: { keepSource: 'json' } });
  const metadata = editNode(name + ' attachment', `({ file: { ...$json.file, name: ${param('name')}, mimeType: 'application/octet-stream' } })`);
  const connections = { ...piece.connections };
  wire(connections, piece.resultNode, output.name); wire(connections, output.name, metadata.name);
  return { ...piece, nodes: [...piece.nodes, output, metadata], connections,
    exits: piece.exits.map(() => metadata.name), resultNode: metadata.name };
}

function fileFormatPiece(name, param, descriptor, parameters, preserveBinary = false) {
  // n8n marks operation selectors noDataExpression. Emit a complete routed piece
  // with fixed-operation actions; no provisional node is constructed or removed.
  const formats = descriptor.parameters.format.options, type = descriptor.nodeType.split('.').at(-1);
  const route = nativeNode(name + ' format', 'switch', { mode: 'expression', numberOutputs: formats.length,
    output: expression(`${JSON.stringify(formats)}.indexOf(${param('format')})`) });
  const done = preserveBinary ? nativeNode(name, 'set', { mode: 'raw', jsonOutput: expression('$json'),
    options: { stripBinary: false }, includeOtherFields: true }) : editNode(name, '$json');
  const actions = formats.map(format => nativeNode(name + ' ' + format, type, { operation: format, ...parameters }));
  const connections = {};
  for (const [index, action] of actions.entries()) {
    wire(connections, route.name, action.name, index); wire(connections, action.name, done.name);
  }
  return { nodes: [route, done, ...actions], connections, entry: route.name, exits: [done.name], resultNode: done.name };
}

function googleSheetsPiece(name, param, credentials) {
  const create = nativeNode(name, 'googleSheets', { authentication: 'oAuth2', resource: 'spreadsheet', operation: 'create',
    title: expression(param('title')), sheetsUi: { sheetValues: [{ title: 'Export' }] }, options: {} }, credentials);
  const aggregate = nativeNode(name + ' input', 'aggregate', { aggregate: 'aggregateAllItemData', destinationFieldName: 'rows', include: 'allFields', options: {} });
  const restore = editNode(name + ' rows', `({ rows: $('${aggregate.name}').first(0, $runIndex).json.rows })`);
  const split = nativeNode(name + ' split rows', 'splitOut', { fieldToSplitOut: 'rows', include: 'noOtherFields', options: { destinationFieldName: 'row' } });
  const values = editNode(name + ' values', '$json.row');
  const write = nativeNode(name + ' append', 'googleSheets', { authentication: 'oAuth2', resource: 'sheet', operation: 'append',
    documentId: { __rl: true, mode: 'id', value: expression(`$('${name}').first(0, $runIndex).json.spreadsheetId`) },
    sheetName: { __rl: true, mode: 'id', value: expression(`String($('${name}').first(0, $runIndex).json.sheets[0].properties.sheetId)`) },
    columns: { mappingMode: 'autoMapInputData', value: {} }, options: { cellFormat: 'RAW', handlingExtraData: 'insertInNewColumn' } }, credentials);
  const done = { ...editNode(name + ' sheet link', `({ spreadsheetId: $('${name}').first(0, $runIndex).json.spreadsheetId, spreadsheetUrl: $('${name}').first(0, $runIndex).json.spreadsheetUrl })`), executeOnce: true };
  const nodes = [aggregate, create, restore, split, values, write, done], connections = {};
  nodes.slice(0, -1).forEach((node, i) => wire(connections, node.name, nodes[i + 1].name));
  return { nodes, connections, entry: aggregate.name, exits: [done.name], resultNode: done.name };
}

function dkgPiece(id, name, credentials, blockId) {
  if (typeof blockId !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/i.test(blockId)) throw new Error('DKG component block identity required.');
  const connections = {};
  const request = nativeNode(name + ' request', 'httpRequest', {
    method: 'POST', url: 'http://127.0.0.1:4631/spike/ka/internal/dkg-component',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json',
    jsonBody: expression(`({ effectId: $('Receive input').first().json.body.invocationId, workflowId: String($workflow.id), executionId: String($execution.id), blockId: ${JSON.stringify(blockId)}, items: $input.all().map(i => i.json) })`),
    options: { timeout: id === 'invoke-dkg-program' ? 45000 : 14000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } },
  }, { executeOnce: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, credentials: { httpHeaderAuth: credentials.httpHeaderAuth } });
  const split = nativeNode(name + ' records', 'splitOut', { fieldToSplitOut: 'items', include: 'noOtherFields', options: { destinationFieldName: 'value' } });
  const result = editNode(name, '$json.value');
  wire(connections,request.name,split.name);wire(connections,split.name,result.name);
  return { nodes:[request,split,result],connections,entry:request.name,exits:[result.name],resultNode:result.name,traceNode:request.name };
}

/** One reviewed native component, with transport-only file conversion where needed. */
export function componentPiece(id, name, param, { credentials = {}, registry = defaultComponentRegistry, blockId } = {}) {
  const { component } = registry;
  const descriptor = component(id), type = descriptor.nodeType.split('.').at(-1);
  const p = key => expression(param(key)), value = key => expression(`$json[${param(key)}]`);
  const resolved = key => `(${resolveComponentValueSource})(${param(key)}, $json)`;
  const nodeCredentials = descriptor.connection && credentials[descriptor.connection]
    ? { credentials: { [descriptor.connection]: credentials[descriptor.connection] } } : {};
  let parameters = {};
  const condition = () => ({ options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: 'equals', leftValue: value('field'), rightValue: p('equals'), operator: { type: 'string', operation: 'equals' } }], combinator: 'and' });
  switch (id) {
    case 'dkg-read': case 'dkg-write': case 'invoke-dkg-program': return dkgPiece(id, name, credentials, blockId);
    case 'edit-fields': parameters = { mode: 'raw', jsonOutput: expression(`({ ...(${param('keepInput')} === 'yes' ? $json : {}), ...${resolved('fields')} })`), options: {} }; break;
    case 'filter': case 'if': parameters = { conditions: condition(), options: {} }; break;
    case 'sort': parameters = { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: p('field'), order: p('direction') }] }, options: {} }; break;
    case 'limit': parameters = { maxItems: p('count'), keep: 'firstItems' }; break;
    case 'remove-duplicates': parameters = { operation: 'removeDuplicateInputItems', compare: 'selectedFields', fieldsToCompare: p('field'), options: {} }; break;
    case 'split-out': parameters = { fieldToSplitOut: p('field'), include: 'allOtherFields', options: { destinationFieldName: 'value' } }; break;
    case 'aggregate': parameters = { aggregate: 'aggregateAllItemData', destinationFieldName: p('field'), include: 'allFields', options: {} }; break;
    case 'summarize': parameters = { fieldsToSummarize: { values: [{ aggregation: 'sum', field: p('field') }] }, options: {} }; break;
    case 'rename-keys': parameters = { keys: { key: [{ currentKey: p('from'), newKey: p('to') }] }, additionalOptions: {} }; break;
    case 'date-time': parameters = { operation: 'formatDate', date: value('field'), format: 'custom', customFormat: p('format'), outputFieldName: 'formattedDate', options: { includeInputFields: true } }; break;
    case 'extract-file': return withFileInput(fileFormatPiece(name, param, descriptor, { binaryPropertyName: 'data', destinationKey: 'text',
      options: { headerRow: true, includeEmptyCells: true, enableBOM: true, relaxQuotes: false } }), name);
    case 'convert-file': return withFileOutput(fileFormatPiece(name, param, descriptor,
      { binaryPropertyName: 'data', options: { fileName: p('name') } }, true), name, param);
    case 'xml': parameters = { mode: 'xmlToJson', dataPropertyName: p('field'), options: {} }; break;
    case 'html': parameters = { operation: 'extractHtmlContent', sourceData: 'json', dataPropertyName: p('field'), extractionValues: { values: [{ key: 'text', cssSelector: p('selector'), returnValue: 'text' }] }, options: {} }; break;
    case 'markdown': parameters = { mode: 'markdownToHtml', markdown: value('field'), destinationKey: 'html', options: {} }; break;
    case 'crypto': parameters = { action: 'hash', type: 'SHA256', value: value('field'), dataPropertyName: 'hash', encoding: 'hex' }; break;
    case 'compression': return withFileOutput(withFileInput(singlePiece(nativeNode(name, type,
      { operation: 'compress', binaryPropertyName: 'data', outputFormat: 'zip', fileName: p('name'), binaryPropertyOutput: 'data' })), name), name, param);
    case 'http-request': parameters = { method: p('method'), url: p('url'),
      sendQuery: true, specifyQuery: 'json', jsonQuery: expression(`JSON.stringify(${resolved('query')})`),
      sendHeaders: true, specifyHeaders: 'json', jsonHeaders: expression(`JSON.stringify(${resolved('headers')})`),
      sendBody: expression(`!['GET', 'HEAD'].includes(${param('method')})`),
      specifyBody: 'json', jsonBody: expression(resolved('body')),
      options: { timeout: 8000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } } }; break;
    case 'google-sheets': return googleSheetsPiece(name, param, nodeCredentials);
    case 'google-drive': return withFileInput(singlePiece(nativeNode(name, type, { resource: 'file', operation: 'upload', inputDataFieldName: 'data',
      name: p('name'), driveId: { __rl: true, mode: 'list', value: 'My Drive' }, folderId: { __rl: true, mode: 'id', value: 'root' }, options: {} }, nodeCredentials)), name);
    case 'switch': parameters = { mode: 'expression', numberOutputs: 2, output: expression(`String($json[${param('field')}]) === String(${param('equals')}) ? 0 : 1`) }; break;
    case 'merge': parameters = { mode: 'append', numberInputs: 2, options: {} }; break;
    case 'merge-fields': parameters = { mode: 'combine', combineBy: 'combineByFields',
      advanced: true, mergeByFields: { values: [{ field1: p('fieldA'), field2: p('fieldB') }] },
      joinMode: p('joinMode'), outputDataFrom: 'both',
      options: { fuzzyCompare: false, multipleMatches: 'all', clashHandling: { values: { resolveClash: 'preferInput1', mergeMode: 'shallowMerge', overrideEmpty: false } } } }; break;
    case 'compare-datasets': parameters = { mergeByFields: { values: [{ field1: p('field'), field2: p('field') }] }, resolve: 'includeBoth', options: {} }; break;
    case 'loop-items': parameters = { batchSize: p('batchSize'), options: {} }; break;
    case 'execute-workflow': {
      const { id: _databaseId, ...embedded } = echoSubworkflow();
      parameters = { source: 'parameter', workflowJson: JSON.stringify(embedded), mode: 'once',
        options: { waitForSubWorkflow: true } }; break;
    }
    case 'stop-error': parameters = { errorType: 'errorMessage', errorMessage: p('message') }; break;
    case 'wait': parameters = { resume: 'timeInterval', amount: p('seconds'), unit: 'seconds' }; break;
    case 'schedule': parameters = { rule: { interval: [{ field: 'minutes', minutesInterval: Number(param('minutes')) }] } }; break;
    case 'webhook': return singlePiece(editNode(name, '$json'));
    default: throw new Error('Unsupported component template.');
  }
  return singlePiece(nativeNode(name, type, parameters, nodeCredentials), descriptor.outputs.length);
}

export function echoSubworkflow() {
  const trigger = nativeNode('Subworkflow input', 'executeWorkflowTrigger', { inputSource: 'passthrough' });
  trigger.typeVersion = 1.1;
  const output = editNode('Subworkflow output', '$json');
  return { id: 'nos_component_echo_v1', name: 'nOS component example sub-workflow', nodes: [trigger, output],
    connections: { [trigger.name]: { main: [[{ node: output.name, type: 'main', index: 0 }]] } }, settings: { executionOrder: 'v1' } };
}

export function standaloneComponentWorkflow(id, workflowId, headerCredential, options = {}) {
  const { component } = options.registry ?? defaultComponentRegistry;
  const descriptor = componentExecutionDescriptor(component(id)), params = key => `$('Prepare input').first().json.params[${JSON.stringify(key)}]`;
  const piece = componentPiece(id, 'Component', id === 'schedule' ? key => JSON.stringify(descriptor.parameters[key].default) : params, { ...options, blockId: 'Component' });
  const receive = nativeNode('Receive input', 'webhook', { httpMethod: 'POST', path: 'dkg-capability-' + workflowId,
    authentication: 'headerAuth', responseMode: 'responseNode', options: {} }, { webhookId: workflowId,
    credentials: { httpHeaderAuth: headerCredential } });
  const ack = nativeNode('Execution accepted', 'respondToWebhook', { respondWith: 'json', responseBody: expression('({ executionId: String($execution.id) })'), options: {} }); ack.typeVersion = 1.4;
  // The installed graph must enforce its contract even when an independently
  // approved Program invokes the tool without our supplied guest wrapper.
  // Validate the entire batch before splitting or entering any native action.
  const prepare = editNode('Prepare input', `(() => { ${componentValidationSource()} const input = normalize(${nativeLiteral(descriptor)}, $('Receive input').first().json.body.input); return { records: JSON.parse(input.itemsJson), params: JSON.parse(input.paramsJson) }; })()`);
  const split = nativeNode('Split input', 'splitOut', { fieldToSplitOut: 'records', include: 'noOtherFields', options: { destinationFieldName: 'record' } });
  const items = editNode('Input items', '$json.record');
  const connections = { ...piece.connections };
  const nodes = id === 'schedule' ? piece.nodes : [receive, ack, prepare, split, items, ...piece.nodes];
  if (id !== 'schedule') {
    const chain = [receive.name, ack.name, prepare.name, split.name, items.name];
    chain.slice(0, -1).forEach((from, i) => wire(connections, from, chain[i + 1]));
    if (descriptor.inputs === 2) {
      const a = nativeNode('Route input', 'if', { conditions: { options: { typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expression('$json._input || 0'), rightValue: 0, operator: { type: 'number', operation: 'equals' } }], combinator: 'and' }, options: {} });
      const cleanA = editNode('Input A', `Object.fromEntries(Object.entries($json).filter(([key]) => key !== '_input'))`);
      const cleanB = editNode('Input B', `Object.fromEntries(Object.entries($json).filter(([key]) => key !== '_input'))`);
      nodes.push(a, cleanA, cleanB); wire(connections, items.name, a.name);
      wire(connections, a.name, cleanA.name, 0); wire(connections, a.name, cleanB.name, 1);
      wire(connections, cleanA.name, piece.entry, 0, 0); wire(connections, cleanB.name, piece.entry, 0, 1);
    } else wire(connections, items.name, piece.entry);
    if (id === 'loop-items') {
      const tick = editNode('Loop body', '$json'); nodes.push(tick);
      wire(connections, piece.resultNode, tick.name, 1); wire(connections, tick.name, piece.entry);
    }
  }
  if (options.scopeName) {
    const scope = editNode(options.scopeName, '$json');
    // Every event root passes through its bound graph/executor observation scope.
    if (id === 'schedule') { nodes.push(scope); wire(connections, piece.entry, scope.name); }
    else {
      for (const routes of Object.values(connections)) for (const port of routes.main) for (const edge of port) {
        if (edge.node === prepare.name) edge.node = scope.name;
      }
      nodes.push(scope); wire(connections, scope.name, prepare.name);
    }
  }
  nodes.forEach((node, i) => { node.position = [i * 240, 0]; });
  return { id: workflowId, name: `nOS KA · ${descriptor.name}`, active: false, nodes, connections,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true },
    result: { nodes: [id === 'webhook' ? items.name : piece.resultNode],
      ...(descriptor.outputs.length > 1 ? { ports: descriptor.outputs } : {}), allowObservation: true } };
}
