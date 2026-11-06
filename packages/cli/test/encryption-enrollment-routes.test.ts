import { describe, expect, it, vi } from 'vitest';
import { handleEncryptionEnrollment } from '../src/daemon/routes/encryption-enrollment.js';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const address = `0x${'1'.repeat(40)}`;
const other = `0x${'2'.repeat(40)}`;
function signed(agentAddress = address, nodeOperator = false): AllowedHttpAuthentication {
  return { allowed: true, mode: 'authenticated', credential: 'agent-key', acceptedToken: undefined, presentedToken: undefined,
    principal: { kind: 'agent', agentAddress, nodeOperator } };
}
async function call(authentication: AllowedHttpAuthentication, activation: boolean, body: unknown) {
  const agent = { prepareEncryptionKeyEnrollment: vi.fn(async () => ({ enrollmentId: 'pending' })),
    activateEncryptionKeyEnrollment: vi.fn(async () => ({ agentAddress: address, encryptionKeyId: 'key' })) };
  const response = { status: 0, body: '', writeHead(status: number) { this.status = status; }, end(body: string) { this.body = body; } };
  await handleEncryptionEnrollment({ authentication, agent, res: response,
    req: { method: 'POST', __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) },
    path: `/api/agent/encryption-enrollments${activation ? '/activate' : ''}` } as unknown as RequestContext);
  return { agent, response };
}
describe('signed encryption custody HTTP boundary', () => {
  it('requires explicit operator preparation and allows an agent with that role', async () => {
    for (const authentication of [signed(), requestAuthentication({ kind: 'anonymous', mode: 'disabled' })]) {
      const { agent, response } = await call(authentication, false, { agentAddress: address });
      expect(response.status).toBe(403); expect(agent.prepareEncryptionKeyEnrollment).not.toHaveBeenCalled();
    }
    const { response } = await call(signed(address, true), false, { agentAddress: address });
    expect(response.status).toBe(201);
  });
  it('requires recipient identity even for an operator; bearer authority alone cannot consent', async () => {
    const body = { agentAddress: address, enrollmentId: 'pending', encryptionKeyProof: 'proof', custodyProof: 'proof' };
    for (const authentication of [signed(other, true), requestAuthentication({ kind: 'nodeOperator' }), requestAuthentication({ kind: 'agent', agentAddress: address })]) {
      const { agent, response } = await call(authentication, true, body);
      expect(response.status).toBe(403); expect(agent.activateEncryptionKeyEnrollment).not.toHaveBeenCalled();
    }
    const { agent, response } = await call(signed(), true, body);
    expect(response.status).toBe(200); expect(agent.activateEncryptionKeyEnrollment).toHaveBeenCalledWith(body);
  });
  it('rejects secret-key uploads and unexpected fields', async () => {
    const { agent, response } = await call(signed(address, true), false, { agentAddress: address, privateKey: 'forbidden' });
    expect(response.status).toBe(400); expect(agent.prepareEncryptionKeyEnrollment).not.toHaveBeenCalled();
    expect(response.body).not.toContain('forbidden');
  });
});
