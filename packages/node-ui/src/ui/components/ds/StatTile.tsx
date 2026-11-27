// A number in a small card: label (with an optional icon), value, optional rich
// content below it, and an optional line of context. The one stat card: the
// Dashboard, Network and Observability all use it.
import React, { useId, useState } from 'react';
import { Info } from 'lucide-react';

const shown = (v: React.ReactNode) => v != null && v !== '';

export function StatTile({ label, value, sub, about, icon, children, className }: {
  label: React.ReactNode;
  value?: React.ReactNode;
  sub?: React.ReactNode;
  /** A longer explanation, shown under the card when the info button is pressed. Never a
   *  tooltip: touch and keyboard users reach it the same way (DESIGN.md · Tooltips). */
  about?: React.ReactNode;
  icon?: React.ReactNode;
  /** Richer content under the value, such as the Dashboard's size breakdown. */
  children?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const aboutId = useId();
  return (
    <div className={`stat-card ds-card${className ? ` ${className}` : ''}`}>
      <div className="stat-label">
        {icon}{label}
        {shown(about) && (
          <button
            type="button"
            className="ds-btn ds-ghost ds-sm ds-icon stat-about-toggle"
            aria-label={open ? 'Hide explanation' : 'What this counts'}
            aria-expanded={open}
            aria-controls={aboutId}
            onClick={() => setOpen((v) => !v)}
          >
            <Info size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {shown(value) && <div className="stat-value">{value}</div>}
      {children}
      {shown(sub) && <div className="stat-sub">{sub}</div>}
      {shown(about) && <div id={aboutId} className="stat-sub stat-about" hidden={!open}>{about}</div>}
    </div>
  );
}
