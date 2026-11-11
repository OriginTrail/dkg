import { afterAll } from 'vitest';
import { readGraphQualificationSuite, type CopyRemovalTiming } from '../test/helpers/read-graph-qualification.js';

const timings: CopyRemovalTiming[] = [];
readGraphQualificationSuite('blazegraph', timings);
afterAll(() => { console.log(`copy removal timings (blazegraph): ${JSON.stringify(timings)}`); });
