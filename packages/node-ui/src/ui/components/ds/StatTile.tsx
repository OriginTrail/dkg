// A number in a small card: label (with an optional icon), value, optional rich
// content below it, and an optional line of context. The one stat card: the
// Dashboard, Network and Observability all use it.
import React from 'react';

const shown = (v: React.ReactNode) => v != null && v !== '';

export function StatTile({ label, value, sub, icon, children, className }: {
  label: React.ReactNode;
  value?: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  /** Richer content under the value, such as the Dashboard's size breakdown. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`stat-card ds-card${className ? ` ${className}` : ''}`}>
      <div className="stat-label">{icon}{label}</div>
      {shown(value) && <div className="stat-value">{value}</div>}
      {children}
      {shown(sub) && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
