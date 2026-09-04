import React, { Suspense } from 'react';

const LOADING_LABELS: Record<string, string> = {
  operations: 'operations', 'agent-hub': 'agent hub', settings: 'settings',
  conviction: 'Publisher Conviction', 'memory-stack': 'memory stack',
  project: 'project', agent: 'agent', wm: 'working memory',
  swm: 'shared memory', vm: 'verifiable memory',
};

interface Props {
  viewId: string;
  children: React.ReactNode;
}

/** Keep navigation usable if a view's chunk is unavailable after a node upgrade. */
export class CenterViewBoundary extends React.Component<Props, { failed: boolean; viewId: string }> {
  state = { failed: false, viewId: this.props.viewId };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { viewId: string }) {
    return props.viewId === state.viewId ? null : { viewId: props.viewId, failed: false };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="lazy-spinner" role="alert">
          <p>This view could not be opened. Reload the page to try again.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      );
    }
    const id = this.props.viewId;
    const label = id.startsWith('conviction:') ? 'account' : LOADING_LABELS[id] ?? LOADING_LABELS[id.split(':')[0]] ?? 'view';
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading {label}...</div>}>
        {this.props.children}
      </Suspense>
    );
  }
}
