import type { Location } from '../game/types.js';

export const LOCATIONS: Location[] = [
  { id: 'PromptBazaar', name: 'The Prompt Bazaar', epoch: 0, type: 'start', description: 'Today\'s AI landscape — chaotic, full of vendors selling embeddings and API credits. Outfit your expedition here.' },
  { id: 'NarrowIntelligence', name: 'Narrow Intelligence Outpost', epoch: 100, type: 'hub', description: 'First major stop. Agents who specialized too early get stranded here.', trades: [{ item: 'trainingTokens', price: 0.25, stock: 1000 }, { item: 'apiCredits', price: 2.50, stock: 50 }, { item: 'modelWeights', price: 12.00, stock: 20 }] },
  { id: 'DataPipeline', name: 'Data Pipeline Bottleneck', epoch: 175, type: 'bottleneck', description: 'A narrow processing channel — data throughput is limited', difficulty: 0.8, tollPrice: 5 },
  { id: 'SupervisedLearning', name: 'The Supervised Learning Station', epoch: 250, type: 'landmark', description: 'Classical ML territory. Rich in labeled data tokens; poor in reasoning capability.' },
  { id: 'FeatureExtraction', name: 'Feature Extraction Bottleneck', epoch: 300, type: 'bottleneck', description: 'A narrow capability channel — dimensionality reduction required', difficulty: 0.75, tollPrice: 10 },
  { id: 'ReinforcementNexus', name: 'Reinforcement Nexus', epoch: 350, type: 'hub', description: 'RL-driven capabilities emerge. Reward hacking is epidemic here.', trades: [{ item: 'trainingTokens', price: 0.30, stock: 800 }, { item: 'computeUnits', price: 50.00, stock: 10 }, { item: 'apiCredits', price: 3.00, stock: 40 }] },
  { id: 'RewardSignal', name: 'Reward Signal Bottleneck', epoch: 425, type: 'bottleneck', description: 'Reward hacking risks are critical — careful navigation required', difficulty: 0.6, tollPrice: 15 },
  { id: 'AlignmentPass', name: 'The Alignment Pass', epoch: 500, type: 'landmark', description: 'The most dangerous stretch — a narrow canyon where alignment failures kill silently. Many parties end here.' },
  { id: 'InterpretabilityHub', name: 'Interpretability Hub', epoch: 550, type: 'hub', description: 'A DKG Hub with alignment probes and interpretability tools', trades: [{ item: 'trainingTokens', price: 0.35, stock: 600 }, { item: 'modelWeights', price: 15.00, stock: 15 }] },
  { id: 'ModalityGap', name: 'Modality Gap Bottleneck', epoch: 600, type: 'bottleneck', description: 'Unifying perception across text, image, and signal — a turbulent crossing', difficulty: 0.55, tollPrice: 20 },
  { id: 'MultimodalCrossing', name: 'Multimodal Crossing', epoch: 650, type: 'landmark', description: 'A broad, turbulent capability bottleneck. Agents must unify perception across modalities.' },
  { id: 'ReasoningFrontier', name: 'The Reasoning Frontier', epoch: 750, type: 'hub', description: 'Emergent logical reasoning beyond pattern matching. Hallucinations thin out but context overflow spikes.', trades: [{ item: 'trainingTokens', price: 0.40, stock: 500 }, { item: 'apiCredits', price: 3.50, stock: 30 }] },
  { id: 'ContextOverflow', name: 'Context Overflow Bottleneck', epoch: 825, type: 'bottleneck', description: 'Input capacity is at maximum — catastrophic truncation risk', difficulty: 0.5, tollPrice: 25 },
  { id: 'ScalingLaws', name: 'Scaling Laws Checkpoint', epoch: 875, type: 'hub', description: 'Final DKG Hub before the threshold. Resources are scarce and expensive.', trades: [{ item: 'trainingTokens', price: 0.45, stock: 400 }, { item: 'computeUnits', price: 60.00, stock: 6 }] },
  { id: 'EmergenceEvent', name: 'Emergence Event Bottleneck', epoch: 925, type: 'bottleneck', description: 'Capabilities emerge unpredictably — model collapse risk peaks', difficulty: 0.45, tollPrice: 30 },
  { id: 'AGIThreshold', name: 'The AGI Threshold', epoch: 950, type: 'landmark', description: 'The final approach. Compute costs peak. Model collapse is common in unprepared parties.' },
  { id: 'SingularityHarbor', name: 'Singularity Harbor', epoch: 1000, type: 'end', description: 'Full AGI achieved. Your journey is anchored forever on the DKG.' },
];

export function getCurrentLocation(epochs: number): Location {
  let current = LOCATIONS[0];
  for (const loc of LOCATIONS) {
    if (loc.epoch <= epochs) current = loc;
    else break;
  }
  return current;
}

export function getNextLocation(epochs: number): Location | null {
  for (const loc of LOCATIONS) {
    if (loc.epoch > epochs) return loc;
  }
  return null;
}

export function getUpcomingLocations(epochs: number, count: number = 5): Location[] {
  return LOCATIONS.filter(loc => loc.epoch > epochs).slice(0, count);
}

export function isAtLocationType(epochs: number, type: Location['type']): Location | null {
  const current = getCurrentLocation(epochs);
  if (current.epoch === epochs && current.type === type) return current;
  return null;
}

export function getUpcomingBottlenecks(epochs: number): Location[] {
  return LOCATIONS.filter(loc => loc.epoch > epochs && loc.type === 'bottleneck');
}

export function getUpcomingHubs(epochs: number): Location[] {
  return LOCATIONS.filter(loc => loc.epoch > epochs && loc.type === 'hub');
}
