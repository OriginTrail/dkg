import React from 'react';
import { ReadGraphsSection } from '../../src/ui/views/project/components/read-graphs.js';
import { ContextGraphQueryView } from '../../src/ui/views/project/components/query.js';
import '../../src/ui/styles.css';

const cg = '0x1111111111111111111111111111111111111111/browser-preview';

/** The read-graphs section and the query view, with the application stylesheet. */
export function ReadGraphViews({ view }: { view: string }) {
  return view === 'read-graphs' ? <ReadGraphsSection contextGraphId={cg} /> : <ContextGraphQueryView contextGraphId={cg} />;
}
