import { useEffect, useRef } from 'react';
import type { Activity } from '../types';
import { OP_COLORS } from '../types';

interface Props {
  activities: Activity[];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const STATUS_ICONS: Record<string, string> = {
  pending: '◌',
  success: '✓',
  error: '✗',
};

export function ActivityFeed({ activities }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && autoScroll.current) {
      el.scrollTop = 0;
    }
  }, [activities.length]);

  return (
    <div className="activity-feed">
      <div className="panel-header">
        <span className="panel-title">Activity Feed</span>
        <span className="badge">{activities.length}</span>
      </div>
      <div className="activity-list" ref={listRef}>
        {activities.length === 0 && (
          <div className="empty-state">No activity yet. Perform an operation to see it here.</div>
        )}
        {activities.map((a) => (
          <div key={a.id} className={`activity-item activity-${a.status}`}>
            <div className="activity-row">
              <span className="activity-icon" style={{ color: OP_COLORS[a.type] }}>
                {STATUS_ICONS[a.status]}
              </span>
              <span className="activity-time">{formatTime(a.ts)}</span>
              <span className="activity-type" style={{ color: OP_COLORS[a.type] }}>
                {a.type}
              </span>
            </div>
            <div className="activity-label">
              <span className="activity-node">Node {a.sourceNode}</span>
              {a.targetNode != null && a.targetNode !== a.sourceNode && (
                <>
                  <span className="activity-arrow">→</span>
                  <span className="activity-node">Node {a.targetNode}</span>
                </>
              )}
              <span className="activity-text">{a.label}</span>
            </div>
            {a.detail && <div className="activity-detail">{a.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
