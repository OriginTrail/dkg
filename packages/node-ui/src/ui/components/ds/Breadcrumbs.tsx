// The way back from a deep view: documents, agents, layers, assets and PCA detail.
// Every crumb but the last is a button; the last names where you are.
import React from 'react';
import { ChevronRight } from 'lucide-react';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="ds-crumbs" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={`${i}-${item.label}`}>
            {item.onClick && !last
              ? <button type="button" className="ds-crumb" title={item.label} onClick={item.onClick}>{item.label}</button>
              : <span className="ds-crumb ds-crumb-current" title={item.label} aria-current={last ? 'page' : undefined}>{item.label}</span>}
            {!last && <ChevronRight size={12} aria-hidden="true" />}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
