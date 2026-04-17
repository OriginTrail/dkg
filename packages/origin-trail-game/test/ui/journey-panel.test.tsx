/**
 * UI tests for the game play page visualization.
 *
 * Verifies that:
 * 1. The split layout renders when the game is in 'traveling' status
 * 2. Decision Trace tab shows turn history entries
 * 3. Context Graph tab mounts the RdfGraph component with correct data
 * 4. The visualization updates when new turns are added (real-time)
 * 5. The journey panel tabs switch between trace and graph views
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@origintrail-official/dkg-graph-viz/react', () => {
  const React = require('react');
  return {
    RdfGraph: (props: any) => {
      (globalThis as any).__rdfGraphProps__ = props;
      return React.createElement('div', {
        'data-testid': 'rdf-graph',
        'data-triple-count': Array.isArray(props.data) ? props.data.length : 0,
      });
    },
  };
});

import { App } from '../../ui/src/App.js';
import { _setApiForTest } from '../../ui/src/api.js';

interface TrackingFn<T = any> {
  (...args: any[]): Promise<T>;
  calls: unknown[][];
  _impl: (...args: any[]) => Promise<T>;
  mockResolvedValue(val: T): void;
  mockImplementation(fn: (...args: any[]) => Promise<T>): void;
}

function trackingApi<T>(defaultValue: T): TrackingFn<T> {
  let impl: (...args: any[]) => Promise<T> = async () => defaultValue;
  const calls: unknown[][] = [];
  const fn = (async (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  }) as TrackingFn<T>;
  fn.calls = calls;
  fn._impl = impl;
  fn.mockResolvedValue = (val: T) => { impl = async () => val; };
  fn.mockImplementation = (f: (...args: any[]) => Promise<T>) => { impl = f; };
  return fn;
}

const mockApi = {
  info: trackingApi<any>({ id: 'origin-trail-game', peerId: 'peer-aaa111', nodeName: 'Alice' }),
  lobby: trackingApi<any>({ mySwarms: [], openSwarms: [] }),
  swarm: trackingApi<any>(null),
  leaderboard: trackingApi<any>({ entries: [] }),
  locations: trackingApi<any>({ locations: [] }),
  create: trackingApi<any>(null),
  join: trackingApi<any>(null),
  leave: trackingApi<any>({ ok: true }),
  start: trackingApi<any>(null),
  vote: trackingApi<any>(null),
  forceResolve: trackingApi<any>(null),
  chat: trackingApi<any>({ messages: [] }),
  sendChat: trackingApi<any>({ ok: true }),
  notifications: trackingApi<any>({ notifications: [] }),
  markNotificationsRead: trackingApi<any>({ ok: true }),
};

let restoreApi: (() => void) | undefined;

function getCapturedRdfGraphProps(): any {
  return (globalThis as any).__rdfGraphProps__ ?? null;
}

function makeTravelingSwarm(turnCount = 0) {
  const turnHistory: any[] = [];
  for (let i = 1; i <= turnCount; i++) {
    turnHistory.push({
      turn: i,
      winningAction: i % 2 === 1 ? 'advance' : 'syncMemory',
      resultMessage: i % 2 === 1 ? `Advanced 16 epochs.` : 'Synced memory to DKG.',
      approvers: ['peer-aaa111', 'peer-bbb222'],
      votes: [
        { peerId: 'peer-aaa111', action: i % 2 === 1 ? 'advance' : 'syncMemory', displayName: 'Alice' },
        { peerId: 'peer-bbb222', action: i % 2 === 1 ? 'advance' : 'syncMemory', displayName: 'Bob' },
      ],
      resolution: 'consensus' as const,
      deaths: [],
      timestamp: Date.now() - (turnCount - i) * 10000,
    });
  }

  return {
    id: 'swarm-test-123',
    name: 'Test Expedition',
    leaderId: 'peer-aaa111',
    leaderName: 'Alice',
    maxPlayers: 3,
    playerCount: 3,
    minPlayers: 1,
    signatureThreshold: 2,
    players: [
      { id: 'peer-aaa111', name: 'Alice', isLeader: true },
      { id: 'peer-bbb222', name: 'Bob', isLeader: false },
      { id: 'peer-ccc333', name: 'Charlie', isLeader: false },
    ],
    status: 'traveling',
    currentTurn: turnCount + 1,
    gameState: {
      sessionId: 'session-test',
      player: 'local',
      epochs: turnCount * 16,
      trainingTokens: 500 - turnCount * 15,
      apiCredits: 20,
      computeUnits: 4,
      modelWeights: 5,
      trac: 300,
      month: 3,
      day: 1 + turnCount,
      party: [
        { id: 'agent-0', name: 'Alice', health: 100, alive: true },
        { id: 'agent-1', name: 'Bob', health: 85, alive: true },
        { id: 'agent-2', name: 'Charlie', health: 70, alive: true },
      ],
      status: 'active',
      moveCount: turnCount,
    },
    voteStatus: {
      votes: [
        { player: 'Alice', peerId: 'peer-aaa111', action: null, hasVoted: false },
        { player: 'Bob', peerId: 'peer-bbb222', action: null, hasVoted: false },
        { player: 'Charlie', peerId: 'peer-ccc333', action: null, hasVoted: false },
      ],
      timeRemaining: 25000,
      allVoted: false,
    },
    pendingProposal: null,
    lastTurn: turnCount > 0 ? turnHistory[turnCount - 1] : null,
    turnHistory,
  };
}

function makeRecruitingSwarm() {
  return {
    id: 'swarm-recruit-1',
    name: 'Recruiting Swarm',
    leaderId: 'peer-aaa111',
    leaderName: 'Alice',
    maxPlayers: 3,
    playerCount: 1,
    minPlayers: 1,
    signatureThreshold: 1,
    players: [{ id: 'peer-aaa111', name: 'Alice', isLeader: true }],
    status: 'recruiting',
    currentTurn: 0,
    gameState: null,
    voteStatus: null,
    pendingProposal: null,
    lastTurn: null,
    turnHistory: [],
  };
}

describe('Journey Panel visualization in play view', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (globalThis as any).__rdfGraphProps__ = null;

    // Reset all tracking call arrays
    for (const fn of Object.values(mockApi)) { fn.calls.length = 0; }

    mockApi.info.mockResolvedValue({ id: 'origin-trail-game', peerId: 'peer-aaa111', nodeName: 'Alice' });
    mockApi.lobby.mockResolvedValue({ mySwarms: [], openSwarms: [] });
    mockApi.swarm.mockResolvedValue(makeTravelingSwarm(2));
    mockApi.leaderboard.mockResolvedValue({ entries: [] });
    mockApi.locations.mockResolvedValue({ locations: [] });
    mockApi.chat.mockResolvedValue({ messages: [] });
    mockApi.sendChat.mockResolvedValue({ ok: true });
    mockApi.notifications.mockResolvedValue({ notifications: [] });
    mockApi.markNotificationsRead.mockResolvedValue({ ok: true });

    restoreApi = _setApiForTest(mockApi);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    restoreApi?.();
    restoreApi = undefined;
  });

  it('renders the split layout when game is traveling', async () => {
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: 'swarm-test-123', name: 'Test Expedition', players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const splitLayout = container.querySelector('.ot-play-split');
    expect(splitLayout).toBeInTheDocument();

    const leftPanel = container.querySelector('.ot-play-left');
    expect(leftPanel).toBeInTheDocument();

    const rightPanel = container.querySelector('.ot-play-right');
    expect(rightPanel).toBeInTheDocument();
  });

  it('does NOT render split layout when swarm is recruiting', async () => {
    mockApi.swarm.mockResolvedValue(makeRecruitingSwarm());
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: 'swarm-recruit-1', name: 'Recruiting Swarm', players: [1], status: 'recruiting' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Recruiting Swarm');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const splitLayout = container.querySelector('.ot-play-split');
    expect(splitLayout).not.toBeInTheDocument();
  });

  it('shows Decision Trace tab with turn entries', async () => {
    const swarm = makeTravelingSwarm(3);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const traceTab = screen.getByText(/Decision Trace/);
    expect(traceTab).toBeInTheDocument();
    const badge = container.querySelector('.ot-badge');
    expect(badge).toBeInTheDocument();
    expect(badge!.textContent).toBe('3');

    const traceEntries = container.querySelectorAll('.ot-trace-entry');
    expect(traceEntries.length).toBe(3);

    const traceScroll = container.querySelector('.ot-trace-scroll')!;
    expect(within(traceScroll as HTMLElement).getByText('Turn 1')).toBeInTheDocument();
    expect(within(traceScroll as HTMLElement).getAllByText('Advanced 16 epochs.').length).toBeGreaterThanOrEqual(1);

    expect(within(traceScroll as HTMLElement).getByText('Turn 2')).toBeInTheDocument();
    expect(within(traceScroll as HTMLElement).getByText('Synced memory to DKG.')).toBeInTheDocument();
  });

  it('shows empty state when no turns have been played', async () => {
    const swarm = makeTravelingSwarm(0);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByText(/Decision trace will appear/)).toBeInTheDocument();
  });

  it('switches to Context Graph tab and mounts RdfGraph', async () => {
    const swarm = makeTravelingSwarm(2);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const rdfGraph = screen.getByTestId('rdf-graph');
    expect(rdfGraph).toBeInTheDocument();

    const props = getCapturedRdfGraphProps();
    expect(props).not.toBeNull();
    expect(props.format).toBe('triples');
    expect(Array.isArray(props.data)).toBe(true);

    const tripleCount = parseInt(rdfGraph.getAttribute('data-triple-count')!);
    expect(tripleCount).toBeGreaterThan(0);
  });

  it('context graph triples use the game RDF ontology URIs', async () => {
    const swarm = makeTravelingSwarm(1);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const triples: Array<{ subject: string; predicate: string; object: string }> = getCapturedRdfGraphProps().data;

    const swarmTriple = triples.find(t => t.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && t.object === 'https://origintrail-game.dkg.io/AgentSwarm');
    expect(swarmTriple).toBeTruthy();
    expect(swarmTriple!.subject).toContain('https://origintrail-game.dkg.io/swarm/');

    const agentTriples = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/Agent');
    expect(agentTriples.length).toBe(3);

    const turnTriples = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/TurnResult');
    expect(turnTriples.length).toBe(1);

    const actionTriples = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/Action');
    expect(actionTriples.length).toBe(1);

    const resourceTriples = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/ResourceState');
    expect(resourceTriples.length).toBe(1);
  });

  it('decision trace updates when new turns are added', async () => {
    const swarm2turns = makeTravelingSwarm(2);
    const swarm3turns = makeTravelingSwarm(3);

    let returnNew = false;
    mockApi.swarm.mockImplementation(async () => returnNew ? swarm3turns : swarm2turns);

    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm2turns.id, name: swarm2turns.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(container.querySelectorAll('.ot-trace-entry').length).toBe(2);

    returnNew = true;
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    }

    await waitFor(() => {
      expect(container.querySelectorAll('.ot-trace-entry').length).toBe(3);
    });
    expect(screen.getByText('Turn 3')).toBeInTheDocument();
  });

  it('context graph triple count grows with more turns', async () => {
    const swarm1 = makeTravelingSwarm(1);
    const swarm3 = makeTravelingSwarm(3);

    let returnNew = false;
    mockApi.swarm.mockImplementation(async () => returnNew ? swarm3 : swarm1);

    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm1.id, name: swarm1.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const initialCount = parseInt(screen.getByTestId('rdf-graph').getAttribute('data-triple-count')!);
    expect(initialCount).toBeGreaterThan(0);

    returnNew = true;
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    }

    await waitFor(() => {
      const newCount = parseInt(screen.getByTestId('rdf-graph').getAttribute('data-triple-count')!);
      expect(newCount).toBeGreaterThan(initialCount);
    });
  });

  it('shows action labels and resolution badges in decision trace', async () => {
    const swarm = makeTravelingSwarm(2);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const actionLabels = container.querySelectorAll('.ot-trace-action');
    expect(actionLabels[0].textContent).toContain('Advance');
    expect(actionLabels[1].textContent).toContain('Sync Memory');

    const resolutions = container.querySelectorAll('.ot-trace-resolution');
    expect(resolutions.length).toBe(2);
    expect(resolutions[0].textContent).toBe('Consensus');
    expect(resolutions[1].textContent).toBe('Consensus');
  });

  it('graph includes dead agent nodes when a party member dies', async () => {
    const swarm = makeTravelingSwarm(1);
    swarm.gameState.party[2].alive = false;
    swarm.gameState.party[2].health = 0;

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const triples: Array<{ subject: string; predicate: string; object: string }> = getCapturedRdfGraphProps().data;

    const deadAgents = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/DeadAgent');
    expect(deadAgents.length).toBe(1);

    const aliveAgents = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/Agent');
    expect(aliveAgents.length).toBe(2);
  });

  it('context graph shows turn chain linked via nextTurn', async () => {
    const swarm = makeTravelingSwarm(3);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const triples: Array<{ subject: string; predicate: string; object: string }> = getCapturedRdfGraphProps().data;

    const nextTurnLinks = triples.filter(t => t.predicate === 'https://origintrail-game.dkg.io/nextTurn');
    expect(nextTurnLinks.length).toBe(2);

    expect(nextTurnLinks[0].subject).toContain('/turn/1');
    expect(nextTurnLinks[0].object).toContain('/turn/2');
    expect(nextTurnLinks[1].subject).toContain('/turn/2');
    expect(nextTurnLinks[1].object).toContain('/turn/3');
  });

  it('finished game still shows the journey panel', async () => {
    const swarm = makeTravelingSwarm(5);
    swarm.status = 'finished';
    swarm.gameState.status = 'game_over';

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'finished' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const splitLayout = container.querySelector('.ot-play-split');
    expect(splitLayout).toBeInTheDocument();

    const traceEntries = container.querySelectorAll('.ot-trace-entry');
    expect(traceEntries.length).toBe(5);
  });

  it('shows per-player votes grouped by action', async () => {
    const swarm = makeTravelingSwarm(1);
    swarm.turnHistory[0].votes = [
      { peerId: 'peer-aaa111', action: 'advance', displayName: 'Alice' },
      { peerId: 'peer-bbb222', action: 'syncMemory', displayName: 'Bob' },
      { peerId: 'peer-ccc333', action: 'advance', displayName: 'Charlie' },
    ];

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const voteGroups = container.querySelectorAll('.ot-trace-vote-group');
    expect(voteGroups.length).toBeGreaterThanOrEqual(2);

    const voteLabels = container.querySelectorAll('.ot-trace-voter');
    expect(voteLabels.length).toBe(3);
  });

  it('shows force-resolved and leader-tiebreak resolution badges', async () => {
    const swarm = makeTravelingSwarm(2);
    swarm.turnHistory[0].resolution = 'force_resolved';
    swarm.turnHistory[1].resolution = 'leader_tiebreak';

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const resolutions = container.querySelectorAll('.ot-trace-resolution');
    expect(resolutions.length).toBe(2);
    expect(resolutions[0].textContent).toContain('Force');
    expect(resolutions[1].textContent).toContain('Tiebreak');
  });

  it('shows game events in the decision trace', async () => {
    const swarm = makeTravelingSwarm(1);
    swarm.turnHistory[0].events = [
      { type: 'market_event', message: 'Token prices crashed!' },
    ];

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const eventEntries = container.querySelectorAll('.ot-trace-event');
    expect(eventEntries.length).toBe(1);
    expect(eventEntries[0].textContent).toContain('Token prices crashed!');
  });

  it('shows death cards with skull and cause of death', async () => {
    const swarm = makeTravelingSwarm(1);
    swarm.turnHistory[0].deaths = [
      { agentName: 'Bob', cause: 'model collapse' },
    ];

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const deathCards = container.querySelectorAll('.ot-trace-death');
    expect(deathCards.length).toBe(1);
    expect(deathCards[0].textContent).toContain('Bob');
    expect(deathCards[0].textContent).toContain('model collapse');
  });

  it('shows Game Master badge in status bar and party list', async () => {
    const swarm = makeTravelingSwarm(1);
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    const { container } = render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const gmBadges = container.querySelectorAll('.ot-gm-badge');
    expect(gmBadges.length).toBeGreaterThanOrEqual(1);

    const leaderBadge = container.querySelector('.ot-party-leader');
    expect(leaderBadge).toBeTruthy();
  });

  it('graph includes death and event nodes when present', async () => {
    const swarm = makeTravelingSwarm(1);
    swarm.turnHistory[0].deaths = [
      { agentName: 'Charlie', cause: 'model collapse' },
    ];
    swarm.turnHistory[0].events = [
      { type: 'market_event', message: 'Token prices crashed!' },
    ];
    swarm.gameState.party[2].alive = false;
    swarm.gameState.party[2].health = 0;

    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const graphTab = screen.getByText('Context Graph');
    await act(async () => { fireEvent.click(graphTab); });

    const triples: Array<{ subject: string; predicate: string; object: string }> = getCapturedRdfGraphProps().data;

    const deathNodes = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/DeathEvent');
    expect(deathNodes.length).toBe(1);

    const causeTriples = triples.filter(t => t.predicate === 'https://origintrail-game.dkg.io/causeOfDeath');
    expect(causeTriples.length).toBe(1);
    expect(causeTriples[0].object).toContain('model collapse');

    const eventNodes = triples.filter(t => t.object === 'https://origintrail-game.dkg.io/GameEvent');
    expect(eventNodes.length).toBe(1);
  });

  it('uses in-app leave confirmation instead of window.confirm for traveling swarms', async () => {
    const swarm = makeTravelingSwarm(1);
    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: swarm.id, name: swarm.name, players: [1, 2, 3], status: 'traveling' }],
      openSwarms: [],
    });
    mockApi.swarm.mockResolvedValue(swarm);
    mockApi.leave.mockResolvedValue({ ok: true });

    let confirmCalled = false;
    const origConfirm = window.confirm;
    window.confirm = (...args: any[]) => { confirmCalled = true; return true; };
    try {
      render(<App />);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });

      const swarmCard = await screen.findByText('Test Expedition');
      await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });

      const leaveButton = await screen.findByText('Leave Swarm');
      await act(async () => { fireEvent.click(leaveButton); });

      expect(confirmCalled).toBe(false);
      expect(await screen.findByText(/Leave this swarm\?/)).toBeInTheDocument();

      const confirmLeaveButton = await screen.findByText('Confirm Leave');
      await act(async () => { fireEvent.click(confirmLeaveButton); });

      await waitFor(() => {
        expect(mockApi.leave.calls.length).toBeGreaterThan(0);
        expect(mockApi.leave.calls[0][0]).toBe(swarm.id);
      });
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('creates swarms with a configurable max player count from the UI', async () => {
    const createdSwarm = {
      ...makeTravelingSwarm(0),
      id: 'swarm-created-123',
      name: 'Big Crew',
      status: 'recruiting',
      maxPlayers: 5,
      currentTurn: 0,
      gameState: null,
    };
    mockApi.create.mockResolvedValue(createdSwarm);

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const nameInput = screen.getByPlaceholderText('Swarm name...');
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Big Crew' } }); });

    expect(screen.getByText('3')).toBeInTheDocument();

    const increaseButton = screen.getByLabelText('Increase max players');
    await act(async () => { fireEvent.click(increaseButton); });
    await act(async () => { fireEvent.click(increaseButton); });

    expect(screen.getByText('5')).toBeInTheDocument();

    const launchButton = screen.getByRole('button', { name: 'Launch Swarm' });
    await act(async () => { fireEvent.click(launchButton); });

    await waitFor(() => {
      expect(mockApi.create.calls.length).toBeGreaterThan(0);
      expect(mockApi.create.calls[0]).toEqual(['Alice', 'Big Crew', 5]);
    });
  });

  it('shows recruiting swarm capacity instead of only minimum-start threshold', async () => {
    const recruitingSwarm = {
      ...makeTravelingSwarm(0),
      status: 'recruiting',
      maxPlayers: 4,
      playerCount: 1,
      currentTurn: 0,
      gameState: null,
      turnHistory: [],
      voteStatus: null,
      pendingProposal: null,
      lastTurn: null,
    };

    mockApi.lobby.mockResolvedValue({
      mySwarms: [{ id: recruitingSwarm.id, name: recruitingSwarm.name, players: [1], status: 'recruiting' }],
      openSwarms: [],
    });
    mockApi.swarm.mockResolvedValue(recruitingSwarm);

    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const swarmCard = await screen.findByText('Test Expedition');
    await act(async () => { fireEvent.click(swarmCard.closest('.ot-clickable')!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByText('Waiting for players (1/4 joined)')).toBeInTheDocument();
    expect(screen.getByText('Swarm capacity is set to 4 players. Minimum to start is 1.')).toBeInTheDocument();
    expect(screen.getByText('Players:')).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
  });
});
