import { resolveComponentValueSource, validateComponentUrlSource, normalizeComponentInputSource } from './guest-sources/component-v2.mjs';
/** Public component descriptors. Credentials and operator endpoints never enter this registry. */
import { resolveComponentValue, validateComponentUrl } from './component-values.mjs';
import { componentProgramSource as componentProgramSourceV1 } from './component-registry-v1.mjs';
import { programDescriptor } from './program-block.mjs';
import { validateDkgProfile, dkgOperationIds, profileOperations, profileParameters } from './dkg-profile.mjs';
const text = (label, value = '', extra = {}) => ({ type: 'string', label, default: value, maxLength: 256, ...extra });
const field = (label, value) => text(label, value, { pattern: 'field', maxLength: 64 });
const number = (label, value, min = 1, max = 20) => ({ type: 'integer', label, default: value, min, max });
const choice = (label, value, options) => text(label, value, { options });
const json = (label, value) => ({ type: 'json', label, default: value, maxLength: 2048 });
const sample = [{ name: 'Ana', value: 12, active: true }, { name: 'Luka', value: 7, active: false }];
const entry = (id, name, category, nodeType, parameters = {}, extra = {}) => ({
  id, name, category, nodeType: `n8n-nodes-base.${nodeType}`, version: 1,
  input: 'items', outputs: ['main'], parameters, sampleItems: sample, mode: 'action', requiresExportAuthorization: false, ...extra,
});

function descriptors(profile) {
  const operations = profile ? profileOperations(profile) : {};
  return [
  entry('edit-fields', 'Edit Fields', 'Data', 'set', {
    fields: json('Field mappings', { team: 'DKG' }),
    keepInput: choice('Keep other input fields', 'yes', ['yes', 'no']),
  }, { version: 2 }),
  entry('filter', 'Filter', 'Data', 'filter', { field: field('Field', 'name'), equals: text('Equals', 'Ana') }),
  entry('sort', 'Sort', 'Data', 'sort', { field: field('Field', 'value'), direction: choice('Direction', 'ascending', ['ascending', 'descending']) }),
  entry('limit', 'Limit', 'Data', 'limit', { count: number('Maximum items', 1) }),
  entry('remove-duplicates', 'Remove Duplicates', 'Data', 'removeDuplicates', { field: field('Compare field', 'name') }),
  entry('split-out', 'Split Out', 'Data', 'splitOut', { field: field('Array field', 'values') }, { sampleItems: [{ values: ['Ana', 'Luka'] }] }),
  entry('aggregate', 'Aggregate', 'Data', 'aggregate', { field: field('Output array field', 'items') }),
  entry('summarize', 'Summarize', 'Data', 'summarize', { field: field('Numeric field to sum', 'value') }),
  entry('rename-keys', 'Rename Keys', 'Data', 'renameKeys', { from: field('Current field', 'name'), to: field('New field', 'fullName') }),
  entry('date-time', 'Date & Time', 'Data', 'dateTime', { field: field('Date field', 'date'), format: text('Output format', 'yyyy-MM-dd') }, { sampleItems: [{ date: '2026-10-23T12:00:00Z' }] }),
  entry('extract-file', 'Extract From File', 'Files', 'extractFromFile', { format: choice('Format', 'csv', ['csv', 'fromJson', 'text', 'xlsx']) }, { input: 'file', sampleItems: [{ file: { name: 'example.csv', mimeType: 'text/csv', base64: 'bmFtZSx2YWx1ZQpBbmEsMTIKTHVrYSw3Cg==' } }] }),
  entry('convert-file', 'Convert to File', 'Files', 'convertToFile', { format: choice('Format', 'csv', ['csv', 'toJson', 'xlsx']), name: text('File name', 'export.csv', { maxLength: 80 }) }, { outputs: ['file'] }),
  entry('xml', 'XML', 'Files', 'xml', { field: field('XML field', 'data') }, { sampleItems: [{ data: '<record><name>Ana</name></record>' }] }),
  entry('html', 'HTML', 'Files', 'html', { field: field('HTML field', 'html'), selector: text('CSS selector', 'h1') }, { sampleItems: [{ html: '<h1>Hello DKG</h1>' }] }),
  entry('markdown', 'Markdown', 'Files', 'markdown', { field: field('Markdown field', 'text') }, { sampleItems: [{ text: '# Hello DKG' }] }),
  entry('crypto', 'Crypto', 'Files', 'crypto', { field: field('Field to hash with SHA-256', 'name') }),
  entry('compression', 'Compression', 'Files', 'compression', { name: text('ZIP file name', 'export.zip', { maxLength: 80 }) }, { input: 'file', outputs: ['file'], sampleItems: [{ file: { name: 'hello.txt', mimeType: 'text/plain', base64: 'SGVsbG8gREtHCg==' } }] }),
  entry('http-request', 'HTTP Request', 'Integrations', 'httpRequest', {
    url: text('API URL', 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m', { maxLength: 2048, pattern: 'http' }),
    method: choice('Method', 'GET', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    query: json('Query parameters', {}), headers: json('Request headers', {}),
    body: { ...json('JSON request body', {}), shape: 'any' },
  }, { sampleItems: [{}], version: 2 }),
  ...(operations['dkg-read'] ? [
    entry('dkg-read', 'DKG Read', 'DKG', 'httpRequest', profileParameters(profile, 'dkg-read'),
      { version: 2, connection: 'httpHeaderAuth', sampleItems: operations['dkg-read'].sampleItems ?? [{}] }),
  ] : []),
  ...(operations['invoke-dkg-program'] ? [
    entry('invoke-dkg-program', 'Invoke DKG Program', 'DKG', 'httpRequest', {
      ...profileParameters(profile, 'invoke-dkg-program'),
      inputs: { ...json('Program arguments · $json is all incoming rows', ['{{ $json }}']), shape: 'any' },
      outputMapping: { ...json('Returned result · $json is the Program output array', '{{ $json }}'), shape: 'any' },
    }, { version: 2, connection: 'httpHeaderAuth', sampleItems: [{}] }),
  ] : []),
  ...(operations['dkg-write'] ? [
    entry('dkg-write', 'DKG Write', 'DKG', 'httpRequest', profileParameters(profile, 'dkg-write'),
      { version: 2, connection: 'httpHeaderAuth', writes: true, requiresExportAuthorization: false, sampleItems: [{}] }),
  ] : []),
  entry('google-sheets', 'Google Sheets', 'Integrations', 'googleSheets', { title: text('New spreadsheet title', 'nOS workflow export', { maxLength: 80 }) }, { connection: 'googleSheetsOAuth2Api', writes: true, requiresExportAuthorization: true }),
  entry('google-drive', 'Google Drive', 'Integrations', 'googleDrive', { name: text('Drive file name', 'nOS-export.txt', { maxLength: 80 }) }, { input: 'file', connection: 'googleDriveOAuth2Api', writes: true, requiresExportAuthorization: true, sampleItems: [{ file: { name: 'hello.txt', mimeType: 'text/plain', base64: 'SGVsbG8gREtHCg==' } }] }),
  entry('if', 'IF', 'Flow', 'if', { field: field('Field', 'name'), equals: text('Equals', 'Ana') }, { outputs: ['true', 'false'], mode: 'branch' }),
  entry('switch', 'Switch', 'Flow', 'switch', { field: field('Field', 'name'), equals: text('First route equals', 'Ana') }, { outputs: ['match', 'other'], mode: 'branch' }),
  entry('merge', 'Merge', 'Flow', 'merge', {}, { inputs: 2, mode: 'join' }),
  entry('merge-fields', 'Merge by fields', 'Flow', 'merge', {
    fieldA: field('Match field in input A', 'joinKey'),
    fieldB: field('Match field in input B', 'joinKey'),
    joinMode: choice('Rows to keep', 'keepEverything', ['keepEverything', 'keepMatches', 'keepNonMatches']),
  }, { inputs: 2, mode: 'join', version: 2 }),
  entry('compare-datasets', 'Compare Datasets', 'Flow', 'compareDatasets', { field: field('Match field', 'name') }, { inputs: 2, outputs: ['only-a', 'same', 'different', 'only-b'], mode: 'join' }),
  entry('loop-items', 'Loop Over Items', 'Flow', 'splitInBatches', { batchSize: number('Batch size', 1) }, { outputs: ['done', 'loop'], mode: 'loop' }),
  entry('execute-workflow', 'Execute Sub-workflow', 'Flow', 'executeWorkflow', {}, { mode: 'subworkflow' }),
  entry('stop-error', 'Stop And Error', 'Flow', 'stopAndError', { message: text('Error message', 'Workflow stopped by its configured rule.') }, { mode: 'stop', outputs: [] }),
  entry('webhook', 'Webhook', 'Events', 'webhook', {}, { input: 'event', mode: 'webhook' }),
  entry('schedule', 'Schedule Trigger', 'Events', 'scheduleTrigger', { minutes: number('Interval in minutes', 5, 1, 1440) }, { input: 'event', mode: 'schedule' }),
  entry('wait', 'Wait', 'Events', 'wait', { seconds: number('Seconds to wait', 1, 1, 3) }, { mode: 'wait' }),
].map(value => Object.freeze(value)); }

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** One operator-selected profile owns descriptors and compilation policy. */
export function createComponentRegistry(profile = null) {
  if (profile) profile = validateDkgProfile(profile);
  const componentRegistry = freeze(structuredClone(descriptors(profile)));
  const component = id => {
    if (id === 'run-program') return programDescriptor;
    const value = componentRegistry.find(item => item.id === id);
    if (!value && dkgOperationIds.includes(id))
      throw Object.assign(new Error('This workflow requires its configured DKG execution profile.'), { code: 'WORKFLOW_CAPABILITY_CHANGED', status: 409 });
    if (!value) throw Object.assign(new Error('Unknown component.'), { code: 'INVALID_COMPONENT', status: 400 });
    return value;
  };
  const componentNeedsExport = descriptor => componentRegistry.find(c => c.id === descriptor?.id)?.requiresExportAuthorization
    ?? descriptor?.requiresExportAuthorization ?? !!descriptor?.writes;
  const context = Object.freeze({ profile, componentRegistry, component, componentNeedsExport,
    componentProgramSource: id => componentProgramSource(id, context) });
  return context;
}
export const defaultComponentRegistry = createComponentRegistry();
export const { componentRegistry, component, componentNeedsExport } = defaultComponentRegistry;

/** Host authorization metadata is outside the immutable guest input contract. */
export function componentExecutionDescriptor({ requiresExportAuthorization: _policy, ...descriptor }) { return descriptor; }

const invalidComponentValue = message => { throw new Error(message); };
const componentRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function inspectComponentValue(value, depth = 0) {
  if (depth > 8) invalidComponentValue('Input is nested too deeply.');
  if (typeof value === 'number' && !Number.isFinite(value)) invalidComponentValue('Use finite JSON numbers.');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('__nos')) invalidComponentValue('Reserved input field.');
    inspectComponentValue(child, depth + 1);
  }
}

/** Normalize persisted paramsJson without records, presentation samples or an execution identity. */
export function normalizeComponentParameters(descriptor, paramsJson) {
  const bad = invalidComponentValue, record = componentRecord;
  if (typeof paramsJson !== 'string' || paramsJson.length > 2048) bad('Use bounded component parameters.');
  const supplied = JSON.parse(paramsJson);
  if (!record(supplied)) bad('Supply component parameters as a JSON object.');
  inspectComponentValue(supplied);
  if (Object.keys(supplied).some(key => !Object.hasOwn(descriptor.parameters, key))) bad('Unexpected component parameter.');
  const params = {};
  for (const [key, spec] of Object.entries(descriptor.parameters)) {
    const selected = Object.hasOwn(supplied, key) ? supplied[key] : spec.default;
    if (spec.type === 'integer') {
      if (!Number.isInteger(selected) || selected < spec.min || selected > spec.max) bad('Invalid ' + spec.label + '.');
    } else if (spec.type === 'json') {
      if (spec.shape !== 'any' && !record(selected) || JSON.stringify(selected).length > spec.maxLength) bad('Invalid ' + spec.label + '.');
      if (descriptor.version >= 2) resolveComponentValue(selected, {}, true);
    } else {
      if (typeof selected !== 'string' || !selected.trim() || selected.length > spec.maxLength
        || spec.options && !spec.options.includes(selected)) bad('Invalid ' + spec.label + '.');
      if (spec.pattern === 'field' && !/^[A-Za-z][A-Za-z0-9_ .-]{0,63}$/.test(selected)) bad('Use a simple field name.');
      if (spec.pattern === 'http') {
        if (descriptor.version < 2 && selected !== 'http://127.0.0.1:4631/spike/ka/demo-data') bad('This saved HTTP revision permits only the local demo-data endpoint.');
        if (descriptor.version >= 2) validateComponentUrl(selected);
      }
    }
    params[key] = selected;
  }
  // Saved definitions own their JSON values, including descriptor defaults.
  return JSON.parse(JSON.stringify(params));
}

/** Host invocation validation. Historical embedded guest bytes remain in guest-sources. */
export function normalizeComponentInput(descriptor, value) {
  const bad = invalidComponentValue, record = componentRecord;
  if (!record(value) || Object.keys(value).some(key => !['itemsJson', 'paramsJson', 'executionId'].includes(key))
    || typeof value.itemsJson !== 'string' || value.itemsJson.length > 8192
    || typeof value.paramsJson !== 'string' || value.paramsJson.length > 2048) bad('Use bounded component input.');
  const items = JSON.parse(value.itemsJson);
  if (!Array.isArray(items) || items.length > 20 || !items.every(record)) bad('Supply up to twenty JSON records and component parameters.');
  inspectComponentValue(items);
  const params = normalizeComponentParameters(descriptor, value.paramsJson);
  if (descriptor.input === 'file') {
    if (!items.length || !items.every(item => record(item.file) && typeof item.file.base64 === 'string'
      && item.file.base64.length <= 6000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.file.base64)
      && typeof item.file.name === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(item.file.name))) bad('Supply a small file as base64 with a simple file name.');
  }
  const executionId = value.executionId ?? '';
  if (typeof executionId !== 'string' || executionId && !/^\d{1,20}$/.test(executionId)) bad('Invalid provider execution identity.');
  if (descriptor.mode === 'schedule' && !executionId) bad('Activate this schedule from a saved workflow to receive events.');
  if (descriptor.id === 'google-sheets' && items.length) {
    const keys = Object.keys(items[0]);
    if (!keys.length || keys.length > 8 || keys.some(k => !/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(k))
      || items.some(item => JSON.stringify(Object.keys(item)) !== JSON.stringify(keys)
        || Object.values(item).some(v => !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 128))) bad('Use up to eight consistent, simply named scalar columns for Google Sheets.');
  }
  return { itemsJson: JSON.stringify(items), paramsJson: JSON.stringify(params), executionId };
}

export function componentValidationSource() {
  return `const resolveComponentValue = ${resolveComponentValueSource};\nconst validateComponentUrl = ${validateComponentUrlSource};\nconst normalize = ${normalizeComponentInputSource};\n`;
}

const stringSchema = maxLength => ({ type: 'string', maxLength });
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const componentContract = {
  inputSchema: objectSchema({ itemsJson: stringSchema(8192), paramsJson: stringSchema(2048), executionId: stringSchema(20) }),
  outputSchema: objectSchema({ ok: { type: 'boolean' }, itemsJson: stringSchema(8192), portsJson: stringSchema(8192), error: stringSchema(512) }),
};

export function componentProgramSource(id, registry = defaultComponentRegistry) {
  const descriptor = registry.component(id);
  if (descriptor.version === 1) return componentProgramSourceV1(id);
  return `// nos-n8n-component-v2:${id}\nimport { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';\n`
    + `const descriptor = ${JSON.stringify(componentExecutionDescriptor(descriptor))};\n${componentValidationSource()}`
    + `export function run(input: unknown) { return invoke_tool('urn:dkg:tool:n8n', normalize(descriptor, input)); }\n`;
}
