// Provider/journal unit fixtures have no signed runtime. Real approval and
// capability enforcement is exercised by semantic-runtime-studio-authority.
export const fixtureProgramAuthority = {
  capture: (workflow, invocationId) => ({ kind: 'unit-fixture', sourceHash: workflow.sourceHash, invocationId }),
  assert: async authority => { if (!authority) throw new Error('Original invocation authority missing'); },
};
