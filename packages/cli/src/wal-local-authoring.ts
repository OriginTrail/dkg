import {
  DkgWalLocalAuthoringBundleError,
  createDkgWalPublisherShadowWriter,
  loadSignedDkgWalLocalAuthoringResolverV1,
  type DkgWalPrivatePayloadResolverV1,
} from '@origintrail-official/dkg-agent';
import type { PublisherWalShadowWriter } from '@origintrail-official/dkg-publisher';
import type { WalRuntime } from '@origintrail-official/dkg-wal';

export interface CreateDaemonWalPublisherShadowWriterOptions {
  runtime: WalRuntime | null;
  networkId: string;
  resolvePrivatePayload?: DkgWalPrivatePayloadResolverV1;
  log?: (message: string) => void;
}

/**
 * Daemon composition boundary for WAL-013. Parallel mode always installs a
 * writer-shaped result path: configured signed evidence authors, while absent
 * evidence fails each shadow mutation visibly before durable state changes.
 */
export async function createDaemonWalPublisherShadowWriter(
  options: CreateDaemonWalPublisherShadowWriterOptions,
): Promise<PublisherWalShadowWriter | undefined> {
  const runtime = options.runtime;
  if (runtime === null || runtime.configuration.mode !== 'parallel') return undefined;
  const localAuthoring = runtime.configuration.localAuthoring;
  if (!localAuthoring) {
    options.log?.('[WAL] local authoring blocked: sync.wal.localAuthoring is not configured');
    return createDkgWalPublisherShadowWriter({
      committer: runtime.localWriter(),
      contextResolver: {
        resolve: async () => {
          throw new DkgWalLocalAuthoringBundleError(
            'WAL_LOCAL_AUTHORING_BUNDLE_UNTRUSTED',
            'signed WAL local-authoring evidence is not configured',
          );
        },
      },
    });
  }
  const resolver = await loadSignedDkgWalLocalAuthoringResolverV1({
    bundlePath: localAuthoring.bundlePath,
    expectedNetworkId: options.networkId,
    expectedCuratorAuthoritySetId: localAuthoring.curatorAuthoritySetId,
    objectStore: runtime.localObjectStore(),
    controlStore: runtime.localControlStore(),
    resolvePrivatePayload: options.resolvePrivatePayload,
  });
  options.log?.(`[WAL] signed local authoring admitted from ${localAuthoring.bundlePath}`);
  return createDkgWalPublisherShadowWriter({ committer: runtime.localWriter(), contextResolver: resolver });
}
