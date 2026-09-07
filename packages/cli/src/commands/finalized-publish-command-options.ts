import { Command } from 'commander';
import { PUBLICATION_PRICING_POLICIES } from '@origintrail-official/dkg-publisher';
import {
  formatFinalizedPublishOptionError,
  type KnowledgeAssetFinalizedPublishOptions,
  parseCliFinalizedPublishOptions,
} from '../finalized-publish-options.js';
import type { ActionOpts } from '../cli-helpers.js';

export function addFinalizedPublishOptions(command: Command): Command {
  return command
    .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
    .option(
      '--pricing-policy <policy>',
      `Token pricing basis (supported: ${PUBLICATION_PRICING_POLICIES.join(', ')})`,
    )
    .option('--publisher-node-identity-id <id>', 'Publisher node identity id override; use 0 for no-attribution');
}

export function parseFinalizedPublishOptions(opts: ActionOpts): KnowledgeAssetFinalizedPublishOptions {
  const parsed = parseCliFinalizedPublishOptions({
    publishEpochs: opts.publishEpochs,
    pricingPolicy: opts.pricingPolicy,
    publisherNodeIdentityId: opts.publisherNodeIdentityId,
  });
  if (!parsed.ok) {
    throw new Error(formatFinalizedPublishOptionError(parsed.error, {
      publishEpochs: '--publish-epochs',
      pricingPolicy: '--pricing-policy',
      publisherNodeIdentityIdOverride: '--publisher-node-identity-id',
    }, { quoteField: false }));
  }
  return parsed.options;
}
