import type { RequestContext, RoutePlugin } from '@origintrail-official/dkg/daemon/plugin-api';
import { createHandler, type KafkaPublishOptions, type KafkaPluginCtx } from './handler.js';
import { coreSchema } from './schema.js';
import { validateExtensionAgainstCore, type KafkaPluginExtension } from './extension.js';

export { coreSchema, CORE_FIELDS } from './schema.js';
export type { CoreFields } from './schema.js';
export { buildKa, mergeAugmentFragment } from './ka-builder.js';
export type { KafkaStreamKa } from './ka-builder.js';
export {
  validateExtensionAgainstCore,
  ExtensionSchemaCollisionError,
  ExtensionSchemaUnsupportedFieldError,
} from './extension.js';
export type { KafkaPluginExtension } from './extension.js';

export interface KafkaPluginOptions<TParsed = Record<string, unknown>> {
  basePath?: string;
  contextGraphId?: string;
  /**
   * Forwarded to the agent as-is. Not validated here: see {@link KafkaPublishOptions}.
   */
  publishOptions?: KafkaPublishOptions;
  extension?: KafkaPluginExtension<TParsed>;
}

const DEFAULT_BASE_PATH = '/api/kafka/streams';

export function createKafkaPlugin<TParsed = Record<string, unknown>>(
  opts: KafkaPluginOptions<TParsed> = {},
): RoutePlugin {
  if (opts.extension) {
    validateExtensionAgainstCore(opts.extension, coreSchema);
  }
  const handle = createHandler({
    basePath: opts.basePath ?? DEFAULT_BASE_PATH,
    contextGraphId: opts.contextGraphId,
    publishOptions: opts.publishOptions,
    extension: opts.extension as KafkaPluginExtension<Record<string, unknown>> | undefined,
  });
  return {
    name: 'kafka-plugin',
    handle(ctx: RequestContext) {
      return handle(ctx);
    },
  };
}

const defaultPlugin: RoutePlugin = createKafkaPlugin();
export default defaultPlugin;
