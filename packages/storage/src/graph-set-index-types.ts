export type GraphSetMutationSource =
  | 'seed'
  | 'revalidate'
  | 'insert'
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'dropGraph'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'replaceSubject'
  | 'replaceSubjectAndInsert'
  | 'rfc64AuthorCommitCasV1'
  | 'query'
  | 'update';

export type TouchedGraphMutationSource =
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'replaceSubject'
  | 'replaceSubjectAndInsert'
  | 'rfc64AuthorCommitCasV1'
  | 'update';
export type GraphSetRefreshSource = 'seed' | 'revalidate' | TouchedGraphMutationSource | 'query';
export type PendingFullRefreshSource = Exclude<GraphSetRefreshSource, 'seed' | 'revalidate'>;

export type GraphSetMutationEvent =
  | {
      type: 'graph-added';
      graph: string;
      source: GraphSetMutationSource;
    }
  | {
      type: 'graph-removed';
      graph: string;
      source: GraphSetMutationSource;
    }
  | {
      type: 'graph-set-revalidated';
      added: string[];
      removed: string[];
      source: GraphSetRefreshSource;
    };

export type GraphSetDiagnosticEvent =
  | {
      type: 'dirty-rebuild';
      source: PendingFullRefreshSource;
      graphCount: number;
    }
  | {
      type: 'probe-retry-exhausted';
      source: TouchedGraphMutationSource;
      probeCount: number;
    };
