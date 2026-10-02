import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { onApiTokenKeptInMemory } from './lib/apiToken.js';

/**
 * The dashboard's router root. A token entered while tab storage is
 * unavailable lives only in this page and would not survive a reload, so the
 * dashboard is remounted in place to refetch with it.
 */
export function Root() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => onApiTokenKeptInMemory(() => setGeneration((n) => n + 1)), []);
  return (
    <BrowserRouter key={generation} basename="/ui">
      <App />
    </BrowserRouter>
  );
}
