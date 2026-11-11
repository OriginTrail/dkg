// Word check for the text people read in the node UI (DESIGN.md · Writing).
// A listed word fails wherever a person could read it: JSX text, the attributes
// people see or hear, labels and messages in objects, and error messages.
import { describe, expect, it } from 'vitest';
import { type Line, shownLines as allLines, shownText as allText, visibleLines, visibleText } from './helpers/visible-text.js';

/** Words DESIGN.md · Writing rules out, with what to use instead. */
const WORDS: [RegExp, string][] = [
  [/\bprincipals?\b/i, 'agent'],
  [/\bruntimes?\b/i, 'agent'],
  [/\bdaemon\b(?!\.log)/i, 'node'],
  [/\bcanonical\b/i, 'remove the word'],
  [/\batomic(ally)?\b/i, 'say what happens'],
  [/\bnonce\b/i, 'remove the word'],
  [/\bprob(e|es|ed|ing)\b/i, 'check'],
  [/\bseed(ed|ing)\b/i, 'say where it came from'],
  [/\bvault(ed|ing)?\b/i, 'saved or stored'],
  [/\btriage\b/i, 'review'],
  [/\benvelopes?\b/i, 'say what it is'],
  [/\bbootstrap(ped|ping)?\b/i, 'say what happens'],
  [/\breachable\b/i, 'Connected'],
  [/\bprocessing\b/i, 'In progress'],
  [/\bawaiting (your )?approval\b/i, 'Approval needed'],
  [/\bpending review\b/i, 'Approval needed'],
  [/\boutcome not confirmed\b/i, 'Outcome unknown'],
  [/\bcarried out\b/i, 'Done'],
  [/\bnot admitted\b/i, 'Refused'],
  [/\bContext Graphs?\b/, 'context graph'],
  [/\b(?:neuro[ -]?[Ss]ymbolic|Neuro(?:[ -][Ss]ymbolic|symbolic))\b/, 'NeuroSymbolic Marketplace, or NS Marketplace'],
  [/\bSPEC_[A-Z]/, 'no spec notes on screen'],
  [/^\d+ · /, 'a label and its detail take a colon'],
];

/**
 * Lines waiting for a wording decision. This list only gets shorter: a line that
 * has changed fails the last test until it is removed here.
 */
const PENDING = new Set<string>([]);


/** Each problem names the file and line, so it can be found even when the text is put together from parts. */
const problemsIn = (lines: Line[]) => lines.flatMap(({ text, where }) => WORDS
  .filter(([word]) => word.test(text))
  .map(([word, use]) => ({ where, text, word: word.source, use })));
const asLines = (texts: string[]): Line[] => texts.map((text) => ({ text, where: 'example' }));


describe('writing rules', () => {
  it('reads every kind of visible text', () => {
    const lines = visibleText(`
      const shown = { label: 'Object label', className: 'not-text' };
      toast('Toast message.');
      throw new Error('Error message');
      export const View = () => (
        <div className="not-text" title="Attribute text" aria-label={ready ? 'Ready name' : 'Waiting name'}>
          Plain text
          {busy ? 'Busy text' : <b data-id="not-text">Nested text</b>}
          {mode === 'not-text' ? 'Mode text' : null}
          <i title={\`Status: \${busy ? 'Template busy' : 'Template idle'}\`} />
          <i title={\`Kind: \${kind === 'not-text' ? 'Kind one' : 'Kind two'}\`} />
        </div>
      );
    `);
    expect([...lines].sort()).toEqual([
      'Attribute text', 'Busy text', 'Error message', 'Kind one', 'Kind two', 'Kind:', 'Mode text', 'Nested text',
      'Object label', 'Plain text', 'Ready name', 'Status:', 'Template busy', 'Template idle', 'Toast message.', 'Waiting name',
    ]);
  });

  it('fails a listed word inside a template interpolation', () => {
    const lines = visibleLines('<div title={`Status: ${busy ? \'processing\' : \'Ready\'}`} />', 'example.tsx');
    expect(problemsIn(lines)).toEqual([{ where: 'example.tsx:1', text: 'processing', word: '\\bprocessing\\b', use: 'In progress' }]);
  });

  it('follows text kept in a constant, but not the values it compares', () => {
    const lines = visibleLines(`
      const text = 'Check the daemon';
      const note = mode === 'daemon' ? 'Managed by the daemon' : 'Signed by your wallet';
      const loop = loop;
      export const View = () => <p title={note}>{text}{loop}</p>;
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Check the daemon', 'Managed by the daemon', 'Signed by your wallet']);
    expect(problemsIn(lines).map((problem) => `${problem.where} ${problem.use}`).sort()).toEqual(['example.tsx:2 node', 'example.tsx:3 node']);
  });

  it('follows what a local helper returns, but not its conditions', () => {
    const lines = visibleLines(`
      function hint() { return 'Check the daemon'; }
      const label = (mode: string) => mode === 'daemon' ? 'Node wallet' : 'Your wallet';
      function outer() { const inner = () => 'Not returned by outer'; return 'Shown'; }
      setError(hint());
      export const View = () => <p>{label(mode)}{outer()}</p>;
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Check the daemon', 'Node wallet', 'Shown', 'Your wallet']);
    expect(problemsIn(lines).map((problem) => `${problem.where} ${problem.use}`)).toEqual(['example.tsx:2 node']);
  });

  it('skips object data marked as not shown', () => {
    const lines = visibleLines(`
      const payload = { reason: 'not admitted', id: 'not-text' }; // writing-rules: not shown
      // writing-rules: not shown
      const audit = {
        message: 'Internal message',
      };
      const request = {
        reason: 'Also internal', // writing-rules: not shown
        message: 'Shown message',
      };
      const tabs = [{ id: 'log', label: 'Tab label' }];
      toast({ message: 'Toast object message', tone: 'not-text' });
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Shown message', 'Tab label', 'Toast object message']);
    expect(problemsIn(lines)).toEqual([]);
  });

  it('reads a lookup the same way as the matching condition', () => {
    const lookup = visibleLines(`
      const labels = { daemon: 'Node wallet', edge: 'Edge text' };
      export const View = () => <p>{labels['daemon']}{labels[mode]}{labels.edge}</p>;
    `, 'example.tsx');
    const condition = visibleLines(`
      export const View = () => <p>{mode === 'daemon' ? 'Node wallet' : 'Edge text'}</p>;
    `, 'example.tsx');
    expect(lookup.map((line) => line.text).sort()).toEqual(['Edge text', 'Node wallet']);
    expect(condition.map((line) => line.text).sort()).toEqual(['Edge text', 'Node wallet']);
  });

  it('treats other expressions as code', () => {
    const lines = visibleLines(`
      export const View = () => (
        <p title={format('daemon key')}>
          {items.map((item) => item.daemon)}{!busy}{count > 0}{api.call('daemon')}{fallback ?? 'Shown fallback'}
        </p>
      );
    `, 'example.tsx');
    expect(lines.map((line) => line.text)).toEqual(['Shown fallback']);
  });

  it('follows each name to its own declaration', () => {
    const lines = visibleLines(`
      function internal() { const text = 'daemon'; return text; }
      export function View() { const text = 'Connected'; return <p>{text}</p>; }
      const shadowed = 'Outer daemon';
      export function Inner() { const shadowed = 'Inner text'; return <p>{shadowed}</p>; }
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Connected', 'Inner text']);
  });

  it('says where each piece of text is', () => {
    const lines = visibleLines('const a = 1;\nexport const View = () => (\n  <p>\n    Shown text\n  </p>\n);\n', 'view.tsx');
    expect(lines).toEqual([{ text: 'Shown text', where: 'view.tsx:4' }]);
  });

  it('finds real text in the UI', () => {
    // One comes from a helper (formatJoinRequestError)
    // and the last from the Marketplace's text table.
    for (const known of [
      'Retry loading agent', 'Copy UAL', 'Context graph', 'You don’t need to connect a wallet',
      'out-of-date network setting', 'The NS Marketplace is off on this node',
    ]) {
      expect([...allText].some((line) => line.includes(known)), known).toBe(true);
    }
  });

  it('fails a listed word', () => {
    expect(problemsIn(asLines(['Check the daemon'])).map((problem) => problem.use)).toEqual(['node']);
    expect(problemsIn(asLines(['2 · Commitment'])).map((problem) => problem.use)).toEqual(['a label and its detail take a colon']);
    expect(problemsIn(asLines(['Open the Context Graph'])).map((problem) => problem.use)).toEqual(['context graph']);
    expect(problemsIn(asLines(['Neurosymbolic Marketplace'])).map((problem) => problem.use)).toEqual(['NeuroSymbolic Marketplace, or NS Marketplace']);
    expect(problemsIn(asLines(['PDF · 8.4 MB', 'Check the node', 'Context graph size', 'My context graphs', 'NeuroSymbolic Marketplace', 'NS Marketplace']))).toEqual([]);
  });

  it('keeps UI text to the word list', () => {
    expect(problemsIn(allLines.filter((line) => !PENDING.has(line.text)))).toEqual([]);
  });

  it('keeps the pending list short', () => {
    expect([...PENDING].filter((line) => !allText.has(line) || problemsIn(asLines([line])).length === 0)).toEqual([]);
  });
});
