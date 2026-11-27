import { PromoteAdmissionAttempt, PromoteAdmissionError } from '../../src/promote-admission.js';

const attempt = new PromoteAdmissionAttempt(1000, () => {});
attempt.enter('graph');
attempt.beginPersistence('job-id');
// @ts-expect-error Persistence has a dedicated transition that requires its ID.
attempt.enter('persist');
// @ts-expect-error Persistence cannot begin without a reconciliation handle.
attempt.beginPersistence();
// @ts-expect-error State is not publicly mutable.
attempt.phase = 'persist';
// @ts-expect-error Identity is not publicly mutable.
attempt.jobId = undefined;
new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'indeterminate', jobId: 'job-id' });
new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'not_admitted' });
// @ts-expect-error Indeterminate admission requires a job ID.
new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'indeterminate' });
// @ts-expect-error A pre-write phase cannot carry indeterminate admission evidence.
new PromoteAdmissionError({ phase: 'conflict', admissionOutcome: 'indeterminate', jobId: 'job-id' });
// @ts-expect-error Non-admission must not claim a job handle.
new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'not_admitted', jobId: 'job-id' });
