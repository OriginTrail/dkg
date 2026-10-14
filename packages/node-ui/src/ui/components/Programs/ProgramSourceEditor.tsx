import React, { lazy, Suspense, useMemo, useState } from 'react';
import { readTypeScriptProgramBundle, updateTypeScriptProgramBundleFile } from '@origintrail-official/dkg-graph-computer';

const Editor = lazy(() => import('./TypeScriptEditor.js'));

/** Persist the complete approved source while displaying one module at a time. */
export default function ProgramSourceEditor({ value, onChange, disabled }: {
  value: string; onChange(value: string): void; disabled: boolean;
}) {
  const [selection, setSelection] = useState('');
  const parsed = useMemo(() => {
    try { return { bundle: readTypeScriptProgramBundle(value), error: '' }; }
    catch (error) { return { bundle: null, error: String(error) }; }
  }, [value]);
  const bundle = parsed.bundle;
  const path = bundle && Object.hasOwn(bundle.files, selection) ? selection : bundle?.entry ?? '';
  return <>
    {parsed.error && <p role="alert">Invalid Program dependency bundle: {parsed.error}</p>}
    {bundle && <>
      <label>Program file<select aria-label="Program file" value={path} onChange={event => setSelection(event.target.value)}>
        {[bundle.entry, ...Object.keys(bundle.files).filter(file => file !== bundle.entry)].map(file =>
          <option key={file} value={file}>{file}{file === bundle.entry ? ' (entry)' : ''}</option>)}
      </select></label>
      <details><summary>Dependency pins</summary>
        <p>All files are included in this Program version. Editing a file requires saving and approving the new version.</p>
        <ul>{Object.entries(bundle.files).map(([file, data]) => <li key={file}>{file}: <code>{data.sha256}</code></li>)}</ul>
        <ul>{Object.entries(bundle.imports).map(([name, file]) => <li key={name}><code>{name}</code> → {file}</li>)}</ul>
      </details>
    </>}
    <Suspense fallback={<p>Loading TypeScript editor…</p>}>
      <Editor key={path || 'single-file'} filename={path || 'main.ts'} value={bundle ? bundle.files[path].source : value}
        disabled={disabled || !!parsed.error} onChange={code => onChange(bundle ? updateTypeScriptProgramBundleFile(value, path, code) : code)} />
    </Suspense>
  </>;
}
