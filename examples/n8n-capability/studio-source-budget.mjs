/** Match readStudio's serialized-source limit, including metadata, grant and executable code. */
export const STUDIO_SOURCE_LIMIT = 65536;
export function assertStudioSourceBudget(source) {
  if (typeof source !== 'string' || source.length > STUDIO_SOURCE_LIMIT)
    throw Object.assign(
      new Error(
        'The compiled workflow exceeds the saved Studio source limit (65536 characters). Reduce its steps or fixed data.',
      ),
      { code: 'INVALID_WORKFLOW', status: 400 },
    );
  return source;
}
