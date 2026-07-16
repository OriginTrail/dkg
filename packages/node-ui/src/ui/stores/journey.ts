import { create } from 'zustand';

export type JourneyStage = 0 | 1 | 2;

interface JourneyState {
  stage: JourneyStage;
  setStage: (s: JourneyStage) => void;
  advance: () => void;
}

function loadStage(): JourneyStage {
  const raw = localStorage.getItem('dkg-journey-stage');
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  return 0;
}

export const useJourneyStore = create<JourneyState>((set, get) => ({
  stage: loadStage(),

  setStage: (s) => {
    localStorage.setItem('dkg-journey-stage', String(s));
    set({ stage: s });
  },

  advance: () => {
    const next = Math.min(get().stage + 1, 2) as JourneyStage;
    localStorage.setItem('dkg-journey-stage', String(next));
    set({ stage: next });
  },
}));
