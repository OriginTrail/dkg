import React, { useEffect, useRef } from 'react';
import { createUuid } from '@origintrail-official/dkg-graph-computer';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type * as TypeScript from 'monaco-editor/languages/features/typescript/register';
import { scriptUrl, styleUrl, editorWorkerUrl, typescriptWorkerUrl } from 'virtual:dkg-monaco-assets';
import { useLayoutStore } from '../../stores/layout.js';

self.MonacoEnvironment = { getWorker: (_module, label) =>
  new Worker(label === 'typescript' || label === 'javascript' ? typescriptWorkerUrl : editorWorkerUrl, { type: 'module' }) };

let runtime: Promise<{ monaco: typeof Monaco; ts: typeof TypeScript }> | undefined;
function loadRuntime() {
  // A separate esbuild bundle keeps the main UI's bounded-memory build small.
  // Both code and styles are served by this node, including in development.
  if (!runtime) {
    const style = document.createElement('link');
    style.rel = 'stylesheet'; style.href = styleUrl;
    document.head.append(style);
    runtime = import(/* @vite-ignore */ scriptUrl).then(({ monaco, ts }) => {
      ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs,
        strict: true, noEmit: true, lib: ['lib.es2022.d.ts'] });
      ts.typescriptDefaults.addExtraLib(`declare module '@origintrail-official/dkg-graph-computer/program' {
        export function invoke_program(program: string, args: unknown[]): Promise<unknown>;
        type Stage = (value: unknown) => unknown | Promise<unknown>;
        export function pipe(value: unknown, ...stages: Stage[]): Promise<unknown>;
        export function map(fn: (row: unknown, index: number) => unknown | Promise<unknown>, options?: {concurrency?: number}): Stage;
        export function reduce(fn: (accumulator: unknown, row: unknown) => unknown | Promise<unknown>, initial: unknown): Stage;
      }`, 'file:///node_modules/@types/dkg-program/index.d.ts');

      return { monaco, ts };
    }).catch(error => { runtime = undefined; style.remove(); throw error; });
  }
  return runtime;
}

export default function TypeScriptEditor({ value, onChange, disabled }: {
  value: string; onChange(value: string): void; disabled: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const latest = useRef({ value, disabled }); latest.current = { value, disabled };
  const [error, setError] = React.useState('');
  const theme = useLayoutStore(s => s.theme);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void loadRuntime().then(({ monaco }) => {
      if (disposed) return;
      const model = monaco.editor.createModel(latest.current.value, 'typescript', monaco.Uri.parse(`file:///program-${createUuid()}.ts`));
      const instance = monaco.editor.create(container.current!, { model, automaticLayout: true,
        readOnly: latest.current.disabled, theme: useLayoutStore.getState().theme === 'dark' ? 'vs-dark' : 'vs',
        minimap: { enabled: false }, wordWrap: 'on', fontSize: 13, tabSize: 2, scrollBeyondLastLine: false,
        ariaLabel: 'TypeScript Program source', fixedOverflowWidgets: true });
      editor.current = instance;
      const subscription = instance.onDidChangeModelContent(() => change.current(instance.getValue()));
      cleanup = () => { subscription.dispose(); instance.dispose(); model.dispose(); editor.current = null; };
    }).catch(cause => { if (!disposed) setError(`Unable to load the editor: ${String(cause)}`); });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  useEffect(() => { if (editor.current && editor.current.getValue() !== value) editor.current.setValue(value); }, [value]);
  useEffect(() => { editor.current?.updateOptions({ readOnly: disabled }); }, [disabled]);
  useEffect(() => { void runtime?.then(({ monaco }) => monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')).catch(() => {}); }, [theme]);
  return <>{error && <p role="alert">{error}</p>}<div className="program-source-editor" ref={container} /></>;
}
