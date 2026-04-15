import React from 'react';
import { useFetch } from '../../hooks.js';
import { api } from '../../api-wrapper.js';

interface TimelineEvent {
  id: string;
  type: string;
  status: string;
  time: string;
  detail?: string;
}

const STATUS_ICONS: Record<string, string> = {
  completed: '✓', failed: '✗', pending: '◌', running: '◉',
  accepted: '◌', claimed: '◌', validated: '◉', broadcast: '◉',
  finalized: '✓', included: '✓',
};

function opToEvents(ops: any[]): TimelineEvent[] {
  return ops.map((op, i) => {
    const type = op.name || op.type || 'operation';
    const status = op.status || 'unknown';
    const time = op.startedAt
      ? new Date(op.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';

    let detail: string | undefined;
    if (type.includes('publish') || type.includes('PUBLISH')) detail = 'Published to Verified Memory';
    else if (type.includes('share') || type.includes('SHARE')) detail = 'Shared to SWM';
    else if (type.includes('write')) detail = 'Wrote to Working Memory';
    else if (type.includes('get') || type.includes('GET')) detail = 'Retrieved knowledge';
    else if (type.includes('subscribe') || type.includes('SUBSCRIBE')) detail = 'Subscribed to context graph';

    return { id: op.id ?? `op-${i}`, type, status, time, detail };
  });
}

export function ActivityTimeline({ contextGraphId }: { contextGraphId?: string }) {
  const { data: opsData } = useFetch(
    () => api.fetchOperationsWithPhases({ limit: '12' }),
    [],
    15_000,
  );

  const events = opToEvents(opsData?.operations ?? []);

  if (events.length === 0) {
    return (
      <div className="v10-timeline">
        <div className="v10-timeline-empty">No recent activity</div>
      </div>
    );
  }

  return (
    <div className="v10-timeline">
      <div className="v10-timeline-header">
        <span className="v10-timeline-title">Activity</span>
      </div>
      <div className="v10-timeline-events">
        {events.map(ev => (
          <div key={ev.id} className={`v10-timeline-event ${ev.status}`}>
            <span className="v10-timeline-event-icon">
              {STATUS_ICONS[ev.status] ?? '·'}
            </span>
            <div className="v10-timeline-event-body">
              <span className="v10-timeline-event-type">{ev.detail ?? ev.type}</span>
              <span className="v10-timeline-event-status">{ev.status}</span>
            </div>
            <span className="v10-timeline-event-time">{ev.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
