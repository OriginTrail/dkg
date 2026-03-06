export interface PartyMember {
  id: string;
  name: string;
  health: number;
  alive: boolean;
}

export interface GameState {
  sessionId: string;
  player: string;
  epochs: number;
  trainingTokens: number;
  apiCredits: number;
  computeUnits: number;
  modelWeights: number;
  trac: number;
  month: number;
  day: number;
  party: PartyMember[];
  status: 'active' | 'won' | 'lost';
  moveCount: number;
  lastEvent?: GameEvent;
}

export interface GameEvent {
  id: string;
  type: 'ai_failure' | 'compute_failure' | 'network_condition' | 'encounter';
  description: string;
  affectedMember?: string;
}

export interface Location {
  id: string;
  name: string;
  epoch: number;
  type: 'start' | 'hub' | 'bottleneck' | 'landmark' | 'end';
  description?: string;
  difficulty?: number;
  tollPrice?: number;
  trades?: TradeOffer[];
}

export interface TradeOffer {
  item: 'trainingTokens' | 'apiCredits' | 'computeUnits' | 'modelWeights';
  price: number;
  stock: number;
}

export type ActionType = 'advance' | 'upgradeSkills' | 'syncMemory' | 'forceBottleneck' | 'payToll' | 'trade';

export interface Action {
  type: ActionType;
  params?: {
    intensity?: 1 | 2 | 3;
    item?: string;
    quantity?: number;
  };
}

export interface ActionResult {
  success: boolean;
  newState: GameState;
  message: string;
  event?: GameEvent;
  creditsGained?: number;
  breakthroughSuccess?: boolean;
}

export interface Move {
  moveNumber: number;
  action: Action;
  timestamp: string;
  previousState: string;
  resultingState: string;
  event?: GameEvent;
}

export const MONTHS = [
  '', '', '', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function formatDate(month: number, day: number): string {
  return `Epoch ${month * 30 + day}`;
}

export function getPartySize(state: GameState): number {
  return state.party.filter(m => m.alive).length;
}
