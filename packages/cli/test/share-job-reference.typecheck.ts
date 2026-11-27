import type { ApiClient } from '../src/api-client.js';

export function shareJobLocatorContracts(client: ApiClient): void {
  void client.knowledgeAssetShareJob('job-id');
  void client.knowledgeAssetShareJob({ jobId: 'job-id' });
  void client.knowledgeAssetShareJob({ url: '/api/knowledge-assets/swm/share-jobs/id' });
  void client.knowledgeAssetShareJob({ jobId: null, url: '/api/knowledge-assets/swm/share-jobs/id' });
  void client.knowledgeAssetShareJob({ jobId: 'id', url: '/api/knowledge-assets/swm/share-jobs/id' });
  // @ts-expect-error A reference must identify a job.
  void client.knowledgeAssetShareJob({});
  // @ts-expect-error Null without a URL is not a locator.
  void client.knowledgeAssetShareJob({ jobId: null });
}
