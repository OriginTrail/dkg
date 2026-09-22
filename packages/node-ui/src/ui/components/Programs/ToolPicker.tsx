import React, { useEffect, useState } from 'react';
import type { OutputSchema, RequestedToolPermissions } from '@origintrail-official/dkg-graph-computer';
import type { QueryCatalogItem } from '@origintrail-official/dkg-core/query-catalog';
import { fetchProgramTools, fetchProgramQueries, type ProgramTool, type ToolKind } from './client.js';
import { readPermissions, rowSchema, simpleRows, toolCall, toolFor, toolIris } from './tool-permissions.js';
import { JsonViewer } from '../common/JsonViewer.js';
import { copyText } from '../common/copyText.js';

export function CopyCall({ code }: { code: string }) {
  const [message, setMessage] = useState('');
  return <div className="program-tool-call"><button type="button" onClick={async () => {
    try { await copyText(code); setMessage('Copied'); } catch { setMessage('Select and copy the example below.'); }
  }}>Copy TypeScript call</button>{message && <span role="status">{message}</span>}
    <details><summary>View call</summary><pre>{code}</pre></details></div>;
}

function OutputContract({ schema, onChange }: { schema: OutputSchema; onChange(value: OutputSchema): void }) {
  const rows = simpleRows(schema);
  const [error, setError] = useState('');
  if (!rows) return <><p className="program-editor-help">This custom output schema is preserved. Edit it under Advanced.</p><JsonViewer value={schema} label="Output schema" /></>;
  const columns = Object.entries(rows.item.properties);
  const update = (name: string, next: string, value: OutputSchema, required: boolean) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next) || ['__proto__', 'constructor', 'prototype'].includes(next) || (name !== next && Object.hasOwn(rows.item.properties, next))) {
      setError('Use a unique SPARQL variable name without the question mark.'); return;
    }
    setError('');
    if (name === next && value === rows.item.properties[name] && required === rows.item.required.includes(name)) return;
    const properties = Object.fromEntries(columns.map(([key, old]) => key === name ? [next, value] : [key, old]));
    const requiredNames = rows.item.required.filter(key => key !== name || required).map(key => key === name ? next : key);
    if (required && !requiredNames.includes(next)) requiredNames.push(next);
    onChange({ ...schema, properties: { bindings: { ...rows.rows, items: { ...rows.item, properties, required: requiredNames } } } } as OutputSchema);
  };
  return <div className="program-tool-columns"><strong>Result columns</strong>
    <p className="program-editor-help">Only these columns may leave the graph. Values are RDF strings; uncheck Required for OPTIONAL variables.</p>
    {columns.map(([name, value]) => <div className="program-tool-column" key={name}>
      <label>Column<input aria-label={`Column ${name}`} defaultValue={name} onBlur={event => { update(name, event.target.value.trim(), value, rows.item.required.includes(name)); event.target.value = name; }} /></label>
      <label>Max characters<input type="number" min={1} max={1048576} value={value.type === 'string' ? value.maxLength : 1024} onChange={event => update(name, name, { ...value, maxLength: Number(event.target.value) } as OutputSchema, rows.item.required.includes(name))} /></label>
      <label className="program-tool-checkbox"><input type="checkbox" checked={rows.item.required.includes(name)} onChange={event => update(name, name, value, event.target.checked)} />Required</label>
      <button type="button" aria-label={`Remove column ${name}`} disabled={columns.length === 1} onClick={() => {
        onChange({ ...schema, properties: { bindings: { ...rows.rows, items: { ...rows.item,
          properties: Object.fromEntries(columns.filter(([key]) => key !== name)), required: rows.item.required.filter(key => key !== name) } } } } as OutputSchema);
      }}>×</button>
    </div>)}
    <button type="button" disabled={columns.length >= 64} onClick={() => {
      let name = 'value'; for (let n = 2; Object.hasOwn(rows.item.properties, name); n++) name = `value${n}`;
      onChange({ ...schema, properties: { bindings: { ...rows.rows, items: { ...rows.item,
        properties: { ...rows.item.properties, [name]: { type: 'string', maxLength: 1024 } }, required: [...rows.item.required, name] } } } } as OutputSchema);
    }}>Add column</button>{error && <p role="alert">{error}</p>}
  </div>;
}

export default function ToolPicker({ graphId, toolsText, permissionsText, onChange }: {
  graphId: string; toolsText: string; permissionsText: string;
  onChange(tools: string, permissions: string): void;
}) {
  const [catalog, setCatalog] = useState<ProgramTool[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Loading available tools…');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [queries, setQueries] = useState<QueryCatalogItem[]>([]);
  const [querySearch, setQuerySearch] = useState('');
  const [queryStatus, setQueryStatus] = useState('');
  let permissions: RequestedToolPermissions = { graphId };
  let parseError = '';
  try {
    permissions = readPermissions(permissionsText) ?? permissions;
    for (const kind of ['query', 'sparqlRead', 'assetCreation'] as const) {
      const grant = permissions[kind];
      if (grant !== undefined && (!grant || typeof grant !== 'object' || Array.isArray(grant))) throw new Error('Invalid tool permission.');
    }
    if (permissions.sparqlRead && (!permissions.sparqlRead.outputSchema || typeof permissions.sparqlRead.toolIri !== 'string')) throw new Error('SPARQL read needs a tool IRI and output schema.');
    if (permissions.query && (!permissions.query.outputSchema || typeof permissions.query.selector !== 'string')) throw new Error('Saved query needs a selector and output schema.');
  } catch (cause) { parseError = (cause as Error).message; }
  const iris = toolIris(toolsText);
  const hasQuery = !!permissions.query && !parseError;
  useEffect(() => {
    let active = true;
    fetchProgramTools().then(value => { if (active) { setCatalog(value.tools); setCatalogStatus(value.enabled ? '' : 'The Graph Computer is disabled on this node.'); } })
      .catch(() => { if (active) setCatalogStatus('Tool discovery is unavailable. Existing declarations are preserved; retry by reopening the editor.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true; setQueries([]); setQuerySearch('');
    if (!hasQuery) return;
    setQueryStatus('Loading saved queries…');
    fetchProgramQueries(graphId).then(value => { if (active) { setQueries(value.items); setQueryStatus(value.items.length ? '' : 'No saved queries in this graph. Save one from the graph’s Query tab first.'); } })
      .catch(cause => { if (active) setQueryStatus(`Could not load saved queries: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { active = false; };
  }, [graphId, hasQuery]);
  const write = (next: RequestedToolPermissions, tools = iris) => onChange(tools.join('\n'), JSON.stringify(next, null, 2));
  const add = (tool: ProgramTool) => {
    const next = { ...permissions, graphId, executionLayer: permissions.executionLayer ?? 'wm' };
    if (tool.kind === 'sparqlRead') next.sparqlRead = { toolIri: tool.toolIri, layer: 'wm', timeoutMs: 5000, maxResultItems: 100, maxOutputBytes: 32768, outputSchema: rowSchema() };
    if (tool.kind === 'query') next.query = { selector: '', outputSchema: rowSchema() };
    if (tool.kind === 'assetCreation') next.assetCreation = { toolIri: tool.toolIri };
    write(next, [...iris, tool.toolIri]); setOpen(false); setSearch('');
  };
  const updateSchema = (kind: 'query' | 'sparqlRead', outputSchema: OutputSchema) => write({ ...permissions, [kind]: { ...permissions[kind], outputSchema } });
  const selected = catalog.filter(tool => permissions[tool.kind]);
  return <section aria-label="Tool picker">
    <p className="program-editor-help">Choose tools, then copy their calls into your code. Saving requests permissions; only Approve Program grants them.</p>
    {parseError ? <p role="alert">{parseError} Correct the JSON under Advanced to use the picker.</p> : <>
      {selected.map(tool => {
        const iri = toolFor(tool.kind, permissions, iris);
        const query = queries.find(item => item.queryIri === permissions.query?.selector);
        const schema = tool.kind === 'query' ? permissions.query?.outputSchema : tool.kind === 'sparqlRead' ? permissions.sparqlRead?.outputSchema : undefined;
        return <section key={tool.kind} className="program-tool-card" aria-label={`${tool.label} permission`}>
          <div className="program-tool-heading"><strong>{tool.label}</strong><button type="button" aria-label={`Remove ${tool.label}`} onClick={() => {
            const next = { ...permissions }; delete next[tool.kind]; write(next, iris.filter(value => value !== iri));
          }}>Remove</button></div>
          <p className="program-editor-help">{tool.description}</p>
          <code className="program-editor-reference">{iri ?? 'Missing tool IRI — edit Advanced'}</code>
          {tool.kind === 'sparqlRead' && permissions.sparqlRead && <>
            <label>Read from<select value={permissions.sparqlRead.layer} onChange={event => write({ ...permissions, sparqlRead: { ...permissions.sparqlRead!, layer: event.target.value as 'wm' | 'swm' | 'vm' } })}>
              <option value="wm">Working Memory</option><option value="swm">Shared Working Memory</option><option value="vm">Verifiable Memory</option></select></label>
            <div className="program-tool-limits">
              <label>Row limit<input type="number" min={1} max={1000} value={permissions.sparqlRead.maxResultItems} onChange={event => {
                const count = Number(event.target.value); const rows = simpleRows(permissions.sparqlRead!.outputSchema);
                write({ ...permissions, sparqlRead: { ...permissions.sparqlRead!, maxResultItems: count,
                  outputSchema: rows ? { ...permissions.sparqlRead!.outputSchema, properties: { bindings: { ...rows.rows, maxItems: count } } } as OutputSchema : permissions.sparqlRead!.outputSchema } });
              }} /></label>
              <label>Read timeout (ms)<input type="number" min={1} max={30000} value={permissions.sparqlRead.timeoutMs} onChange={event => write({ ...permissions, sparqlRead: { ...permissions.sparqlRead!, timeoutMs: Number(event.target.value) } })} /></label>
              <label>Output limit (bytes)<input type="number" min={1} max={1048576} value={permissions.sparqlRead.maxOutputBytes} onChange={event => write({ ...permissions, sparqlRead: { ...permissions.sparqlRead!, maxOutputBytes: Number(event.target.value) } })} /></label>
            </div></>}
          {tool.kind === 'query' && <>
            <label>Find a saved query<input type="search" value={querySearch} onChange={event => setQuerySearch(event.target.value)} placeholder="Name or query IRI" /></label>
            <label>Saved query<select value={permissions.query!.selector} onChange={event => write({ ...permissions, query: { ...permissions.query!, selector: event.target.value } })}>
              <option value="">Select a saved query</option>
              {permissions.query!.selector && !queries.some(item => item.queryIri === permissions.query!.selector) && <option value={permissions.query!.selector}>{permissions.query!.selector} (stored selector)</option>}
              {queries.filter(item => item.queryIri === permissions.query!.selector || `${item.name} ${item.queryIri}`.toLowerCase().includes(querySearch.toLowerCase())).map(item => <option key={item.queryIri} value={item.queryIri}>{item.name} · {item.catalogName}</option>)}
            </select></label>{queryStatus && <p className="program-editor-help">{queryStatus}</p>}
            {query && <details><summary>Query and parameters</summary><pre>{query.sparql}</pre><p className="program-editor-reference">Scope: {query.subGraph || 'Entire graph'}</p>{query.parameters.map(param => <p key={param.name}>{param.name} · {param.type}{param.required ? ' · required' : ''}</p>)}</details>}
            {simpleRows(permissions.query!.outputSchema) && <label>Row limit<input type="number" min={1} max={1000} value={simpleRows(permissions.query!.outputSchema)!.rows.maxItems} onChange={event => {
              const rows = simpleRows(permissions.query!.outputSchema)!;
              updateSchema('query', { ...permissions.query!.outputSchema, properties: { bindings: { ...rows.rows, maxItems: Number(event.target.value) } } } as OutputSchema);
            }} /></label>}
          </>}
          {tool.kind === 'assetCreation' && <p className="program-editor-help">May create assets in this operation graph’s {permissions.executionLayer === 'swm' ? 'Shared Working Memory' : permissions.executionLayer === 'vm' ? 'Verifiable Memory (on-chain publication)' : 'Working Memory'}. This does not grant arbitrary SPARQL updates.</p>}
          {schema && <OutputContract schema={schema} onChange={value => updateSchema(tool.kind as 'query' | 'sparqlRead', value)} />}
          {iri && <CopyCall code={toolCall(tool.kind, iri, permissions, Object.fromEntries((query?.parameters ?? []).map(param => [param.name, String(param.defaultValue ?? `<${param.name}>`)])))} />}
        </section>;
      })}
      {catalogStatus && <p className="program-editor-help" role="status">{catalogStatus}</p>}
      <button type="button" disabled={!catalog.length || selected.length === catalog.length || iris.length >= 3} onClick={() => setOpen(!open)}>+ Add tool</button>
      {open && <div className="program-tool-menu"><label>Find a tool<input type="search" autoFocus placeholder="Search available tools" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {catalog.filter(tool => !permissions[tool.kind] && `${tool.label} ${tool.description}`.toLowerCase().includes(search.toLowerCase())).map(tool => <button type="button" className="program-tool-option" key={tool.kind} disabled={iris.includes(tool.toolIri)} onClick={() => add(tool)}><strong>{tool.label}</strong><span>{tool.description}</span></button>)}
      </div>}
      {!!selected.length && <label>Store execution results and new assets in<select value={permissions.executionLayer ?? 'wm'} onChange={event => write({ ...permissions, executionLayer: event.target.value as 'wm' | 'swm' | 'vm' })}>
        <option value="wm">Working Memory</option><option value="swm">Shared Working Memory</option><option value="vm">Verifiable Memory</option>
      </select></label>}
    </>}
    <details className="program-tool-advanced" open={!!parseError || undefined}><summary>Advanced · tool IDs and permissions JSON</summary>
      <p className="program-editor-help">Custom IDs name the supported capabilities; they do not install new tools. Changes here are reflected in the forms.</p>
      <label>Tool IRIs<textarea rows={3} value={toolsText} onChange={event => onChange(event.target.value, permissionsText)} /></label>
      <label>Requested tool permissions (JSON)<textarea rows={9} value={permissionsText} onChange={event => onChange(toolsText, event.target.value)} /></label>
    </details>
  </section>;
}
