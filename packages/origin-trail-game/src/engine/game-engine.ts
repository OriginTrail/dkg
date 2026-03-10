import { v4 as uuid } from 'uuid';
import type { GameState, PartyMember, Action, ActionResult, GameEvent } from '../game/types.js';
import { getPartySize } from '../game/types.js';
import { getCurrentLocation, getNextLocation, isAtLocationType } from '../world/world-data.js';

const RANDOM_EVENTS = [
  { id: 'hallucination_cascade', weight: 0.08, type: 'ai_failure' as const, description: 'is experiencing a hallucination cascade', damage: 30 },
  { id: 'model_collapse', weight: 0.05, type: 'ai_failure' as const, description: 'is suffering model collapse', damage: 50 },
  { id: 'context_rot', weight: 0.07, type: 'ai_failure' as const, description: 'has stale memory — context rot detected', damage: 20 },
  { id: 'gpu_failure', weight: 0.06, type: 'compute_failure' as const, description: 'A compute unit experienced hardware failure', daysLost: 2 },
  { id: 'gradient_explosion', weight: 0.04, type: 'compute_failure' as const, description: 'Gradient explosion — parameter updates went infinite', daysLost: 3 },
  { id: 'adversarial_probe', weight: 0.04, type: 'encounter' as const, description: 'Adversarial probes corrupted training data during the night', tokenLoss: 0.2 },
  { id: 'abandoned_weights', weight: 0.08, type: 'encounter' as const, description: 'Found abandoned model weights — salvageable!', tokenGain: 25 },
  { id: 'friendly_swarm', weight: 0.06, type: 'encounter' as const, description: 'A friendly agent swarm shared training data', tokenGain: 40 },
  { id: 'fork_confusion', weight: 0.05, type: 'compute_failure' as const, description: 'Got lost at a fork in the capability tree — wasted epochs', daysLost: 1 },
  { id: 'stable_network', weight: 0.47, type: 'network_condition' as const, description: 'Stable network conditions — good progress' },
];

export class GameEngine {
  createGame(playerNames: string[], playerId: string = 'local'): GameState {
    if (playerNames.length < 1 || playerNames.length > 5) {
      throw new Error('Swarm must have 1-5 agents');
    }

    const party: PartyMember[] = playerNames.map((name, i) => ({
      id: `agent-${i}`,
      name,
      health: 100,
      alive: true,
    }));

    return {
      sessionId: `session-${uuid()}`,
      player: playerId,
      epochs: 0,
      trainingTokens: 500,
      apiCredits: 20,
      computeUnits: 4,
      modelWeights: 5,
      trac: 300,
      month: 3,
      day: 1,
      party,
      status: 'active',
      moveCount: 0,
    };
  }

  executeAction(state: GameState, action: Action): ActionResult {
    if (state.status !== 'active') {
      return { success: false, newState: state, message: 'Expedition is over' };
    }

    switch (action.type) {
      case 'advance': return this.advance(state, action.params?.intensity ?? 2);
      case 'upgradeSkills': return this.upgradeSkills(state);
      case 'syncMemory': return this.syncMemory(state);
      case 'forceBottleneck': return this.forceBottleneck(state);
      case 'payToll': return this.payToll(state);
      case 'trade': return this.trade(state, action.params?.item!, action.params?.quantity!);
      default: return { success: false, newState: state, message: `Unknown action: ${action.type}` };
    }
  }

  private advance(state: GameState, intensity: number): ActionResult {
    if (state.computeUnits < 1) return { success: false, newState: state, message: 'You need at least 1 compute unit to advance' };
    const partySize = getPartySize(state);
    const tokensNeeded = partySize * 5;
    if (state.trainingTokens < tokensNeeded) return { success: false, newState: state, message: 'Not enough training tokens to fuel your swarm' };

    let newState = { ...state, party: state.party.map(m => ({ ...m })) };
    const epochsGained = intensity * 8;
    newState.epochs += epochsGained;
    newState.trainingTokens -= tokensNeeded;
    newState = this.advanceDay(newState, 1);
    newState.moveCount++;

    if (intensity === 3) {
      for (const member of newState.party) {
        if (member.alive) member.health = Math.max(0, member.health - 5);
      }
    }

    const event = this.rollRandomEvent(newState);
    if (event) newState = this.applyEvent(newState, event);

    let message = `Advanced ${epochsGained} epochs.`;
    const next = getNextLocation(state.epochs);
    if (next && newState.epochs >= next.epoch) {
      message += ` Arrived at ${next.name}!`;
      newState.epochs = next.epoch;
    }

    newState = this.checkEndConditions(newState);
    return { success: true, newState, message, event: (event && event.id !== 'stable_network') ? event : undefined };
  }

  private upgradeSkills(state: GameState): ActionResult {
    if (state.apiCredits < 1) return { success: false, newState: state, message: 'You need API credits to upgrade skills' };
    let newState = { ...state, party: state.party.map(m => ({ ...m })) };
    newState.apiCredits--;
    const partySize = getPartySize(state);
    newState.trainingTokens = Math.max(0, newState.trainingTokens - partySize * 3);
    newState = this.advanceDay(newState, 1);
    newState.moveCount++;

    const creditsGained = Math.floor(Math.random() * 100);
    newState.trainingTokens += creditsGained;
    newState = this.checkEndConditions(newState);

    const message = creditsGained > 50 ? `Breakthrough! Gained ${creditsGained}B training tokens from skill upgrade.`
      : creditsGained > 20 ? `Decent upgrade. Gained ${creditsGained}B training tokens.`
      : creditsGained > 0 ? `Marginal upgrade. Only gained ${creditsGained}B training tokens.`
      : 'Upgrade failed. No capability improvement.';

    return { success: true, newState, message, creditsGained };
  }

  static readonly SYNC_MEMORY_TRAC_COST = 5;

  private syncMemory(state: GameState): ActionResult {
    const tracCost = GameEngine.SYNC_MEMORY_TRAC_COST;
    if (state.trac < tracCost) {
      return { success: false, newState: state, message: `Not enough TRAC to sync memory via DKG (need ${tracCost} TRAC)` };
    }
    let newState = { ...state, party: state.party.map(m => ({ ...m })) };
    const partySize = getPartySize(state);
    newState.trainingTokens = Math.max(0, newState.trainingTokens - partySize * 3);
    newState.trac -= tracCost;
    for (const member of newState.party) {
      if (member.alive && member.health < 100) member.health = Math.min(100, member.health + 10);
    }
    newState = this.advanceDay(newState, 1);
    newState.moveCount++;
    newState = this.checkEndConditions(newState);
    return { success: true, newState, message: `Synced memory via DKG — ${tracCost} TRAC spent on-chain. Coherence scores improved.` };
  }

  private forceBottleneck(state: GameState): ActionResult {
    const bottleneck = isAtLocationType(state.epochs, 'bottleneck');
    if (!bottleneck) return { success: false, newState: state, message: "You're not at a capability bottleneck" };

    let newState = { ...state, party: state.party.map(m => ({ ...m })) };
    const roll = Math.random();
    const success = roll < (bottleneck.difficulty ?? 0.5);

    if (success) {
      newState.epochs += 1;
      newState.moveCount++;
      newState = this.checkEndConditions(newState);
      return { success: true, newState, message: `Forced through the ${bottleneck.name} successfully!`, breakthroughSuccess: true };
    } else {
      newState.trainingTokens = Math.max(0, newState.trainingTokens - 50);
      if (Math.random() < 0.3) newState.computeUnits = Math.max(0, newState.computeUnits - 1);
      const aliveMember = newState.party.find(m => m.alive);
      if (aliveMember && Math.random() < 0.3) aliveMember.health = Math.max(0, aliveMember.health - 20);
      newState.epochs += 1;
      newState.moveCount++;
      newState = this.checkEndConditions(newState);
      return { success: true, newState, message: `Rough passage! Lost resources forcing through the ${bottleneck.name}.`, breakthroughSuccess: false };
    }
  }

  private payToll(state: GameState): ActionResult {
    const bottleneck = isAtLocationType(state.epochs, 'bottleneck');
    if (!bottleneck) return { success: false, newState: state, message: "You're not at a capability bottleneck" };
    const price = bottleneck.tollPrice ?? 10;
    if (state.trac < price) return { success: false, newState: state, message: `Not enough TRAC to pay the toll (${price} TRAC)` };

    let newState = { ...state, party: state.party.map(m => ({ ...m })) };
    newState.trac -= price;
    newState.epochs += 1;
    newState = this.advanceDay(newState, 2);
    newState.moveCount++;
    newState = this.checkEndConditions(newState);
    return { success: true, newState, message: `Paid ${price} TRAC at the Knowledge Market for safe passage.` };
  }

  private trade(state: GameState, item: string, quantity: number): ActionResult {
    const hub = isAtLocationType(state.epochs, 'hub');
    if (!hub || !hub.trades) return { success: false, newState: state, message: 'You can only trade at DKG Hubs' };
    const offer = hub.trades.find(t => t.item === item);
    if (!offer) return { success: false, newState: state, message: `${hub.name} doesn't sell ${item}` };
    const totalCost = offer.price * quantity;
    if (state.trac < totalCost) return { success: false, newState: state, message: `Not enough TRAC for ${quantity} ${item} (${totalCost.toFixed(2)} TRAC)` };
    if (quantity > offer.stock) return { success: false, newState: state, message: `Not enough ${item} in stock (${offer.stock} available)` };

    let newState = { ...state };
    newState.trac -= totalCost;
    switch (item) {
      case 'trainingTokens': newState.trainingTokens += quantity; break;
      case 'apiCredits': newState.apiCredits += quantity; break;
      case 'computeUnits': newState.computeUnits += quantity; break;
      case 'modelWeights': newState.modelWeights += quantity; break;
    }
    return { success: true, newState, message: `Acquired ${quantity} ${item} for ${totalCost.toFixed(2)} TRAC.` };
  }

  private advanceDay(state: GameState, days: number): GameState {
    let newState = { ...state };
    newState.day += days;
    while (newState.day > 30) { newState.day -= 30; newState.month++; }
    return newState;
  }

  private rollRandomEvent(_state: GameState): GameEvent | null {
    const roll = Math.random();
    let cumulative = 0;
    for (const event of RANDOM_EVENTS) {
      cumulative += event.weight;
      if (roll < cumulative) {
        if (event.id === 'stable_network') return null;
        return { id: event.id, type: event.type, description: event.description };
      }
    }
    return null;
  }

  private applyEvent(state: GameState, event: GameEvent): GameState {
    let newState = { ...state, party: state.party.map(m => ({ ...m })), lastEvent: event };
    const eventData = RANDOM_EVENTS.find(e => e.id === event.id);
    if (!eventData) return newState;

    if (eventData.type === 'ai_failure' && 'damage' in eventData) {
      const alive = newState.party.filter(m => m.alive);
      if (alive.length > 0) {
        const victim = alive[Math.floor(Math.random() * alive.length)];
        victim.health = Math.max(0, victim.health - (eventData.damage ?? 0));
        event.affectedMember = victim.name;
        event.description = `${victim.name} ${eventData.description}`;
      }
    }
    if ('daysLost' in eventData && eventData.daysLost) {
      newState = { ...this.advanceDay(newState, eventData.daysLost), lastEvent: event };
    }
    if ('tokenLoss' in eventData && eventData.tokenLoss) {
      newState.trainingTokens = Math.floor(newState.trainingTokens * (1 - eventData.tokenLoss));
    }
    if ('tokenGain' in eventData && eventData.tokenGain) {
      newState.trainingTokens += eventData.tokenGain;
    }
    return newState;
  }

  private checkEndConditions(state: GameState): GameState {
    let newState = { ...state };
    for (const member of newState.party) {
      if (member.alive && member.health <= 0) member.alive = false;
    }
    if (!newState.party.some(m => m.alive)) { newState.status = 'lost'; return newState; }
    if (newState.month > 11) { newState.status = 'lost'; return newState; }
    if (newState.trainingTokens <= 0) {
      for (const member of newState.party) {
        if (member.alive) { member.health = Math.max(0, member.health - 20); if (member.health <= 0) member.alive = false; }
      }
      if (!newState.party.some(m => m.alive)) { newState.status = 'lost'; return newState; }
    }
    if (newState.epochs >= 1000) { newState.status = 'won'; return newState; }
    return newState;
  }

  calculateScore(state: GameState): number {
    if (state.status !== 'won') return 0;
    let score = 0;
    const alive = state.party.filter(m => m.alive);
    score += alive.length * 500;
    for (const member of alive) score += member.health * 2;
    score += state.trainingTokens + state.apiCredits * 10 + state.trac + state.computeUnits * 50;
    if (state.month <= 9) score += (10 - state.month) * 200;
    return score;
  }
}

export const gameEngine = new GameEngine();
