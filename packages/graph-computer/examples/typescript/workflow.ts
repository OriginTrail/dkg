import { invoke_program, pipe, map, reduce }
  from '@origintrail-official/dkg-graph-computer/program';

const scale = 'urn:example:program:scale:v1';

export async function run(values: unknown[], factor: number) {
  const scaled = map(value => invoke_program(scale, [value, factor]), { concurrency: 4 });
  const total = reduce((sum, value) => Number(sum) + Number(value), 0);
  return pipe(values, scaled, total);
}
