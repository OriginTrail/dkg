import { describe, it, expect } from 'vitest';
import { LOCATIONS, getCurrentLocation, getNextLocation } from '../src/world/world-data.js';
import { GameEngine } from '../src/engine/game-engine.js';
import type { GameState } from '../src/game/types.js';

function makeGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    sessionId: 'test-session',
    player: 'local',
    epochs: 0,
    trainingTokens: 500,
    apiCredits: 20,
    computeUnits: 4,
    modelWeights: 5,
    trac: 300,
    month: 3,
    day: 1,
    party: [{ id: 'agent-0', name: 'TestAgent', health: 100, alive: true }],
    status: 'active',
    moveCount: 0,
    ...overrides,
  };
}

describe('world-data — LOCATIONS', () => {
  it('all locations have epoch values between 0 and 1000', () => {
    for (const loc of LOCATIONS) {
      expect(loc.epoch).toBeGreaterThanOrEqual(0);
      expect(loc.epoch).toBeLessThanOrEqual(1000);
    }
  });

  it('first location is at epoch 0 with type start', () => {
    expect(LOCATIONS[0].epoch).toBe(0);
    expect(LOCATIONS[0].type).toBe('start');
  });

  it('last location is at epoch 1000 with type end', () => {
    const last = LOCATIONS[LOCATIONS.length - 1];
    expect(last.epoch).toBe(1000);
    expect(last.type).toBe('end');
  });

  it('locations are in ascending epoch order', () => {
    for (let i = 1; i < LOCATIONS.length; i++) {
      expect(LOCATIONS[i].epoch).toBeGreaterThan(LOCATIONS[i - 1].epoch);
    }
  });
});

describe('world-data — getCurrentLocation', () => {
  it('returns the start location at epoch 0', () => {
    const loc = getCurrentLocation(0);
    expect(loc.epoch).toBe(0);
    expect(loc.type).toBe('start');
  });

  it('returns AlignmentPass at epoch 500', () => {
    const loc = getCurrentLocation(500);
    expect(loc.id).toBe('AlignmentPass');
  });

  it('returns the end location at epoch 1000', () => {
    const loc = getCurrentLocation(1000);
    expect(loc.epoch).toBe(1000);
    expect(loc.type).toBe('end');
  });
});

describe('world-data — getNextLocation', () => {
  it('returns the second location from epoch 0', () => {
    const next = getNextLocation(0);
    expect(next).not.toBeNull();
    expect(next!.epoch).toBe(100);
  });

  it('returns null at epoch 1000', () => {
    expect(getNextLocation(1000)).toBeNull();
  });
});

describe('world-data — win condition via GameEngine', () => {
  it('sets status to won when epochs reach 1000', () => {
    const engine = new GameEngine();
    const state = makeGameState({ epochs: 992, trainingTokens: 1000, computeUnits: 10 });

    const result = engine.executeAction(state, { type: 'advance', params: { intensity: 1 } });
    expect(result.success).toBe(true);
    expect(result.newState.epochs).toBeGreaterThanOrEqual(1000);
    expect(result.newState.status).toBe('won');
  });
});
