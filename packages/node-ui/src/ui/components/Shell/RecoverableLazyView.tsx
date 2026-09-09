import React, { Suspense } from 'react';

type LoadingLabel<Props> = string | ((props: Props) => string);

const CHUNK_LOAD_MESSAGES = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading (?:css )?chunk [^ ]+ failed/i,
];

function findChunkLoadFailure(error: unknown, depth = 0): Error | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;
  if (error.name === 'ChunkLoadError') return error;
  if ((error as Error & { code?: unknown }).code === 'CSS_CHUNK_LOAD_FAILED') return error;
  if (CHUNK_LOAD_MESSAGES.some((pattern) => pattern.test(error.message))) return error;
  return findChunkLoadFailure((error as Error & { cause?: unknown }).cause, depth + 1);
}

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
  load: () => Promise<React.ComponentType<Props>>,
  label: LoadingLabel<Props>,
) {
  function RecoverableChunkLoadFailure(_props: Props) {
    return <ChunkLoadFailure />;
  }

  const LazyView = React.lazy(async () => {
    try {
      return { default: await load() };
    } catch (error) {
      const chunkFailure = findChunkLoadFailure(error);
      if (!chunkFailure) throw error;
      console.error('Failed to load a lazy view chunk.', chunkFailure);
      return { default: RecoverableChunkLoadFailure };
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
