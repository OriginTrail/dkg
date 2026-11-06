// A number in a small card: label, value, and an optional line of context.
import React from 'react';

export function StatTile({ label, value, sub }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="stat-card ds-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub != null && sub !== '' && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
