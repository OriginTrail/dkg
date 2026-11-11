import { afterAll } from 'vitest';
import { readGraphQualificationSuite, type CopyRemovalTiming } from './helpers/read-graph-qualification.js';

const timings: CopyRemovalTiming[] = [];
readGraphQualificationSuite('oxigraph', timings);
afterAll(() => { if (process.env.DKG_REPORT_COPY_TIMINGS === '1') console.log(`copy removal timings (oxigraph): ${JSON.stringify(timings)}`); });
