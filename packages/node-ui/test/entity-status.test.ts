// One status policy for decisions, tasks and pull requests: the activity
// feed and the generated entity cards both render its badge tone.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { entityStatusTone } from '../src/ui/lib/entity-status.js';
import { DecisionCardImpl as DecisionCard, PRCardImpl as PRCard, TaskCardImpl as TaskCard } from '../src/ui/genui/components.js';

describe('entity status tone', () => {
  it('maps every known status to one badge tone', () => {
    expect(['accepted', 'done', 'merged'].map(entityStatusTone)).toEqual(['success', 'success', 'success']);
    expect(['proposed', 'open', 'in_progress'].map(entityStatusTone)).toEqual(['warning', 'warning', 'warning']);
    expect(['rejected', 'superseded', 'cancelled', 'blocked', 'closed'].map(entityStatusTone)).toEqual(['danger', 'danger', 'danger', 'danger', 'danger']);
    expect(['', 'unknown'].map(entityStatusTone)).toEqual(['neutral', 'neutral']);
  });

  it('is the tone the generated cards render', () => {
    const tone = (el: React.ReactElement) => renderToStaticMarkup(el).match(/ds-tone-(\w+)/)?.[1];
    const render = (Comp: any, props: Record<string, unknown>) => React.createElement(Comp, { props, renderNode: () => null });
    expect(tone(render(DecisionCard, { title: 'D', status: 'accepted' }))).toBe('success');
    expect(tone(render(TaskCard, { title: 'T', status: 'blocked' }))).toBe('danger');
    expect(tone(render(PRCard, { title: 'P', state: 'closed' }))).toBe('danger');
    expect(tone(render(PRCard, { title: 'P', state: 'open' }))).toBe('warning');
  });
});
