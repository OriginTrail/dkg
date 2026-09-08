import { Command } from 'commander';
import { PUBLICATION_PRICING_POLICIES } from '@origintrail-official/dkg-publisher';
import {
  formatFinalizedPublishOptionError,
  type KnowledgeAssetFinalizedPublishOptions,
  type CliFinalizedPublishInput,
  parseCliFinalizedPublishOptions,
} from '../finalized-publish-options.js';

const CLI_ERROR_LABELS: Partial<Record<keyof KnowledgeAssetFinalizedPublishOptions, string>> = {
  publishEpochs: '--publish-epochs',
  pricingPolicy: '--pricing-policy',
  publisherNodeIdentityIdOverride: '--publisher-node-identity-id',
};

export function addFinalizedPublishOptions(command: Command): Command {
  return command
    .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)')
    .option('--pricing-policy <policy>', `Token pricing basis (supported: ${PUBLICATION_PRICING_POLICIES.join(', ')})`)
    .option('--publisher-node-identity-id <id>', 'Publisher node identity id override; use 0 for no-attribution');
}

export function parseFinalizedPublishOptions(opts: CliFinalizedPublishInput): KnowledgeAssetFinalizedPublishOptions {
  const parsed = parseCliFinalizedPublishOptions(opts);
  if (!parsed.ok) {
    throw new Error(formatFinalizedPublishOptionError(parsed.error, CLI_ERROR_LABELS, { quoteField: false }));
  }
  return parsed.options;
}
