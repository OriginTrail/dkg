import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_ID_MAX_WIDTH,
  CONTEXT_GRAPH_NAME_MAX_WIDTH,
  formatContextGraphTable,
  truncateTableCell,
} from '../src/context-graph-table.js';

describe('context-graph terminal table', () => {
  it('keeps ordinary context graph metadata readable', () => {
    const output = formatContextGraphTable([{
      id: 'agent/music',
      name: 'Music',
      creator: '0x1234',
      isSystem: false,
    }]).join('\n');

    expect(output).toContain('agent/music');
    expect(output).toContain('Music');
    expect(output).toContain('user');
    expect(output).toContain('1 context graph(s)');
  });

  it('sanitizes and bounds untrusted long cells instead of producing megabyte lines', () => {
    const output = formatContextGraphTable([{
      id: `agent/${'i'.repeat(100_000)}`,
      name: `hostile\nname\t${'n'.repeat(100_000)}`,
      creator: `0x${'c'.repeat(100)}`,
      isSystem: true,
    }]);

    expect(output.every((line) => line.length <= 130)).toBe(true);
    expect(output.join('\n')).not.toContain('\nname');
    expect(output.join('\n')).toContain('…');
    expect(truncateTableCell('x'.repeat(100), CONTEXT_GRAPH_ID_MAX_WIDTH)).toHaveLength(
      CONTEXT_GRAPH_ID_MAX_WIDTH,
    );
    expect(truncateTableCell('x'.repeat(100), CONTEXT_GRAPH_NAME_MAX_WIDTH)).toHaveLength(
      CONTEXT_GRAPH_NAME_MAX_WIDTH,
    );
  });
});
