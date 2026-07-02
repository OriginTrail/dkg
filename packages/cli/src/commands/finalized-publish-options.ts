import { Command } from 'commander';
import {
  formatFinalizedPublishOptionError,
  type KnowledgeAssetFinalizedPublishOptions,
  normalizeFinalizedPublishOptions,
} from '../finalized-publish-options.js';
import type { ActionOpts } from '../cli-helpers.js';

export function addFinalizedPublishOptions(command: Command): Command {
  return command
    .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
    .option('--publisher-node-identity-id <id>', 'Publisher node identity id override; use 0 for no-attribution');
}

export function parseFinalizedPublishOptions(opts: ActionOpts): KnowledgeAssetFinalizedPublishOptions {
  const parsed = normalizeFinalizedPublishOptions({
    publishEpochs: opts.publishEpochs,
    publisherNodeIdentityIdOverride: opts.publisherNodeIdentityId,
  });
  if (!parsed.ok) {
    throw new Error(formatFinalizedPublishOptionError(parsed.error, {
      publishEpochs: '--publish-epochs',
      publisherNodeIdentityIdOverride: '--publisher-node-identity-id',
    }, { quoteField: false }));
  }
  const { publishEpochs, publisherNodeIdentityIdOverride } = parsed.options;
  return {
    ...(publishEpochs !== undefined ? { publishEpochs } : {}),
    ...(publisherNodeIdentityIdOverride !== undefined ? { publisherNodeIdentityIdOverride } : {}),
  };
}
