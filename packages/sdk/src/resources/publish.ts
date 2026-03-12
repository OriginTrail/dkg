import { HttpClient } from '../http.js';
import type {
  PublishQuadsInput,
  PublishResult,
  WorkspaceEnshrineInput,
  WorkspaceEnshrineResult,
  WorkspaceWriteInput,
  WorkspaceWriteResult,
} from '../types.js';

export class PublishResource {
  constructor(private readonly http: HttpClient) {}

  async quads(input: PublishQuadsInput): Promise<PublishResult> {
    return this.http.post<PublishResult>('/api/publish', input);
  }

  async workspaceWrite(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    return this.http.post<WorkspaceWriteResult>('/api/workspace/write', input);
  }

  async workspaceEnshrine(input: WorkspaceEnshrineInput): Promise<WorkspaceEnshrineResult> {
    return this.http.post<WorkspaceEnshrineResult>('/api/workspace/enshrine', {
      paranetId: input.paranetId,
      selection: input.selection ?? 'all',
      clearAfter: input.clearAfter ?? true,
    });
  }
}
