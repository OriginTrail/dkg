import React, { lazy, Suspense } from 'react';
import type { ProgramEditorProps } from './ProgramEditor.js';

// The editor and its code editor load only when someone opens it.
const ProgramEditor = lazy(() => import('./ProgramEditor.js'));

/** The Program editor as a dialog, loaded on first open. */
export function ProgramEditorDialog({ open, ...props }: ProgramEditorProps & { open: boolean }) {
  if (!open) return null;
  return (
    <Suspense fallback={<div role="status">Loading Program editor…</div>}>
      <ProgramEditor {...props} />
    </Suspense>
  );
}
