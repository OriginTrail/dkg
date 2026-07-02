import { Command } from 'commander';
import type { KnowledgeAssetFinalizedPublishOptions } from '../api-client.js';
import { parseOptionalNonNegativeBigInt, parseOptionalPositiveInteger } from '../cli-option-parsers.js';
import type { ActionOpts } from '../cli-helpers.js';

export function addFinalizedPublishOptions(command: Command): Command {
  return command
    .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
    .option('--publisher-node-identity-id <id>', 'Publisher node identity id override; use 0 for no-attribution');
}

export function parseFinalizedPublishOptions(opts: ActionOpts): KnowledgeAssetFinalizedPublishOptions {
  const publishEpochs = parseOptionalPositiveInteger(opts.publishEpochs, '--publish-epochs');
  const publisherNodeIdentityIdOverride = parseOptionalNonNegativeBigInt(
    opts.publisherNodeIdentityId,
    '--publisher-node-identity-id',
  );
  return {
    ...(publishEpochs !== undefined ? { publishEpochs } : {}),
    ...(publisherNodeIdentityIdOverride !== undefined ? { publisherNodeIdentityIdOverride } : {}),
  };
}
