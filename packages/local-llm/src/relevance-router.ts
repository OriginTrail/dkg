export interface RelevanceDocument<T> {
  item: T;
  name: string;
  description?: string;
  schema?: unknown;
  category: string;
  jsonBytes: number;
}

export interface RelevanceRankedItem<T> {
  item: T;
  name: string;
  category: string;
  score: number;
  lexicalScore: number;
  pinned: boolean;
  jsonBytes: number;
}

export interface RelevanceRankResult<T> {
  selected: RelevanceRankedItem<T>[];
  jsonBytes: number;
}

export interface RelevanceRankOptions {
  query: string;
  limit?: number;
  jsonBudget?: number;
  pinnedNames?: ReadonlySet<string>;
  excludedNames?: ReadonlySet<string>;
  anchorNames?: readonly string[];
  categoryBoost?: (category: string) => number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'have', 'how', 'i', 'in', 'is', 'me', 'my', 'of', 'on', 'or', 'please',
  'the', 'this', 'to', 'what', 'when', 'where', 'which', 'who', 'with', 'you',
]);

const EXPANSIONS = new Map<string, readonly string[]>([
  ['inspect', ['query', 'read', 'list']],
  ['inside', ['content', 'query', 'list']],
  ['tell', ['get', 'query', 'search', 'show']],
  ['show', ['get', 'list', 'query', 'read']],
  ['see', ['get', 'list', 'show']],
  ['visible', ['get', 'list', 'show']],
  ['available', ['get', 'list', 'show']],
  ['joined', ['get', 'list']],
  ['find', ['get', 'query', 'search']],
  ['running', ['health', 'status', 'connectivity']],
  ['populate', ['create', 'write', 'knowledge', 'asset']],
  ['fact', ['knowledge', 'asset', 'write', 'query']],
  ['graph', ['context', 'query']],
  ['project', ['context', 'graph']],
  ['cg', ['context', 'graph', 'list']],
  ['cgs', ['context', 'graph', 'list']],
]);

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function stem(token: string): string {
  if (token.endsWith('eed') || token === 'ahead') return token;
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenizeToolText(text: string): string[] {
  const normalized = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return [];
  return normalized.split(/\s+/)
    .map(stem)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function expandedTokens(text: string, ignoredTokens: ReadonlySet<string>): Set<string> {
  const tokens = new Set(tokenizeToolText(text).filter((token) => !ignoredTokens.has(token)));
  for (const token of Array.from(tokens)) {
    for (const expansion of EXPANSIONS.get(token) ?? []) tokens.add(stem(expansion));
  }
  return tokens;
}

function fuzzy(query: string, document: Set<string>): number {
  if (document.has(query)) return 1;
  if (query.length < 4) return 0;
  for (const token of document) {
    if (token.length >= 4 && (token.startsWith(query) || query.startsWith(token))) return 0.35;
  }
  return 0;
}

export function createRelevanceRanker<T>(documents: RelevanceDocument<T>[]): {
  maxLexicalScore(query: string, ignoredTokens?: ReadonlySet<string>): number;
  rank(options: RelevanceRankOptions): RelevanceRankResult<T>;
} {
  const candidates = documents.map((document) => ({
    ...document,
    nameTokens: new Set(tokenizeToolText(document.name.replace(/^dkg_/, ''))),
    descriptionTokens: new Set(tokenizeToolText(document.description ?? '')),
    schemaTokens: new Set(tokenizeToolText(JSON.stringify(document.schema ?? {}))),
  }));
  const frequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const token of new Set([
      ...candidate.nameTokens,
      ...candidate.descriptionTokens,
      ...candidate.schemaTokens,
    ])) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  const score = (query: string, ignoredTokens: ReadonlySet<string> = new Set()) => {
    const queryTokens = expandedTokens(query, ignoredTokens);
    return candidates.map((candidate) => {
      let lexicalScore = 0;
      for (const token of queryTokens) {
        const rarity = Math.log(
          (candidates.length + 1) / ((frequency.get(token) ?? candidates.length) + 1),
        ) + 1;
        lexicalScore += 9 * rarity * fuzzy(token, candidate.nameTokens);
        lexicalScore += 2.5 * rarity * fuzzy(token, candidate.descriptionTokens);
        lexicalScore += 1.25 * rarity * fuzzy(token, candidate.schemaTokens);
      }
      return { candidate, lexicalScore };
    });
  };

  return {
    maxLexicalScore(query, ignoredTokens = new Set()) {
      return Math.max(0, ...score(query, ignoredTokens).map(({ lexicalScore }) => lexicalScore));
    },

    rank(options) {
      const limit = positiveInteger(options.limit, 8);
      const jsonBudget = positiveInteger(options.jsonBudget, 18_000);
      const pinnedNames = options.pinnedNames ?? new Set<string>();
      const excludedNames = options.excludedNames ?? new Set<string>();
      const ranked = score(options.query)
        .filter(({ candidate }) => !excludedNames.has(candidate.name))
        .map(({ candidate, lexicalScore }) => {
          const pinned = pinnedNames.has(candidate.name);
          return {
            item: candidate.item,
            name: candidate.name,
            category: candidate.category,
            lexicalScore,
            pinned,
            score: lexicalScore
              + (options.categoryBoost?.(candidate.category) ?? 0)
              + (pinned ? 1_000 : 0),
            jsonBytes: candidate.jsonBytes,
          };
        })
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
      const anchors = new Set(options.anchorNames ?? []);
      const ordered = [
        ...ranked.filter((candidate) => anchors.has(candidate.name)),
        ...ranked.filter((candidate) => !anchors.has(candidate.name)),
      ];
      const selected: RelevanceRankedItem<T>[] = [];
      let jsonBytes = 0;
      for (const candidate of ordered) {
        if (selected.length >= limit) break;
        if (jsonBytes + candidate.jsonBytes > jsonBudget) continue;
        selected.push(candidate);
        jsonBytes += candidate.jsonBytes;
      }
      return { selected, jsonBytes };
    },
  };
}
