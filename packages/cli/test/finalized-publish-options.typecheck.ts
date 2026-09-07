import { parseCliFinalizedPublishOptions } from '../src/finalized-publish-options.js';
import { parseFinalizedPublishOptions } from '../src/commands/finalized-publish-command-options.js';

parseCliFinalizedPublishOptions({ publishEpochs: '12', pricingPolicy: 'full-content', publisherNodeIdentityId: '0' });
// @ts-expect-error Misspelled CLI options must remain visible to callers.
parseCliFinalizedPublishOptions({ publishEpohcs: '12' });
// @ts-expect-error HTTP aliases are not Commander input names.
parseCliFinalizedPublishOptions({ epochs: '12' });
// @ts-expect-error The command adapter has the same narrow input contract.
parseFinalizedPublishOptions({ publisherNodeIdentityOverride: '1' });
