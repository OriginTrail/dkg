import React, { Suspense } from 'react';

type LazyModule<Props> = { default: React.ComponentType<Props> };
type LoadingLabel<Props> = string | ((props: Props) => string);

function ChunkLoadFailure() {
  return (
    <div className="lazy-spinner" role="alert">
      <p>This view could not be opened. Reload the page to try again.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload page</button>
    </div>
  );
}

/** Add loading and recovery UI to a dynamic import without catching view render errors. */
export function createRecoverableLazyView<Props extends object>(
  load: () => Promise<LazyModule<Props>>,
  label: LoadingLabel<Props>,
) {
  const LazyView = React.lazy(async () => {
    try {
      return await load();
    } catch {
      return { default: ChunkLoadFailure as React.ComponentType<Props> };
    }
  });

  function RecoverableLazyView(props: Props) {
    const loadingLabel = typeof label === 'function' ? label(props) : label;
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading {loadingLabel}...</div>}>
        <LazyView {...props} />
      </Suspense>
    );
  }

  return RecoverableLazyView;
}
