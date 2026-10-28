import { afterEach, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { assertCheckpointMemory, checkpointJavaArguments } from '../src/snapshot-checkpoint-profile.js';
vi.mock('node:os', () => ({ availableParallelism: vi.fn(() => 8), totalmem: vi.fn(() => 8 * 2 ** 30) }));
afterEach(() => vi.restoreAllMocks());
it('retains the existing heap and caps Java parallelism without inflating a smaller CPU allowance', () => {
  expect(checkpointJavaArguments()).toEqual(['-Xms256m', '-Xmx3g', '-XX:ActiveProcessorCount=4']);
  vi.mocked(os.availableParallelism).mockReturnValue(2);
  expect(checkpointJavaArguments()).toEqual(['-Xms256m', '-Xmx3g', '-XX:ActiveProcessorCount=2']);
});
it('keeps the memory floor inclusive and honors the tighter constrained allowance', () => {
  vi.spyOn(process, 'constrainedMemory').mockReturnValue(4 * 2 ** 30);
  expect(assertCheckpointMemory).not.toThrow();
  vi.mocked(process.constrainedMemory).mockReturnValue(4 * 2 ** 30 - 1);
  expect(assertCheckpointMemory).toThrow('4 GiB memory allowance');
  vi.mocked(process.constrainedMemory).mockReturnValue(0);
  vi.mocked(os.totalmem).mockReturnValue(4 * 2 ** 30 - 1);
  expect(assertCheckpointMemory).toThrow('4 GiB memory allowance');
});
