import { Command } from 'commander';
import {
  FINALIZED_PUBLISH_CLI_OPTIONS,
  formatFinalizedPublishOptionError,
  type KnowledgeAssetFinalizedPublishOptions,
  parseCliFinalizedPublishOptions,
} from '../finalized-publish-options.js';

export function addFinalizedPublishOptions(command: Command): Command {
  for (const option of FINALIZED_PUBLISH_CLI_OPTIONS) {
    command.option(option.flags, option.description);
  }
  return command;
}

export function parseFinalizedPublishOptions(opts: Record<string, unknown>): KnowledgeAssetFinalizedPublishOptions {
  const parsed = parseCliFinalizedPublishOptions(opts);
  if (!parsed.ok) {
    const labels = Object.fromEntries(FINALIZED_PUBLISH_CLI_OPTIONS.map((option) =>
      [option.errorField, option.flags.split(' ')[0]],
    ));
    throw new Error(formatFinalizedPublishOptionError(parsed.error, labels, { quoteField: false }));
  }
  return parsed.options;
}
