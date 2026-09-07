import { Command } from 'commander';
import { PUBLICATION_PRICING_POLICIES } from '@origintrail-official/dkg-publisher';
import {
  formatFinalizedPublishOptionError,
  type KnowledgeAssetFinalizedPublishOptions,
  type CliFinalizedPublishInput,
  parseCliFinalizedPublishOptions,
} from '../finalized-publish-options.js';

const FINALIZED_PUBLISH_CLI_OPTIONS = [
  {
    errorField: 'publishEpochs', flags: '--publish-epochs <count>',
    description: 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)',
  },
  {
    errorField: 'pricingPolicy', flags: '--pricing-policy <policy>',
    description: `Token pricing basis (supported: ${PUBLICATION_PRICING_POLICIES.join(', ')})`,
  },
  {
    errorField: 'publisherNodeIdentityIdOverride', flags: '--publisher-node-identity-id <id>',
    description: 'Publisher node identity id override; use 0 for no-attribution',
  },
];

export function addFinalizedPublishOptions(command: Command): Command {
  for (const option of FINALIZED_PUBLISH_CLI_OPTIONS) {
    command.option(option.flags, option.description);
  }
  return command;
}

export function parseFinalizedPublishOptions(opts: CliFinalizedPublishInput): KnowledgeAssetFinalizedPublishOptions {
  const parsed = parseCliFinalizedPublishOptions(opts);
  if (!parsed.ok) {
    const labels = Object.fromEntries(FINALIZED_PUBLISH_CLI_OPTIONS.map((option) =>
      [option.errorField, option.flags.split(' ')[0]],
    ));
    throw new Error(formatFinalizedPublishOptionError(parsed.error, labels, { quoteField: false }));
  }
  return parsed.options;
}
