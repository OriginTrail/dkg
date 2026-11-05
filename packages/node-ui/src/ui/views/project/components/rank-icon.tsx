import type { ReactNode } from 'react';
import { Check, CircleHelp, Diamond, Eye, Rss } from 'lucide-react';

/** The icon on the "Your role" pill, so the pill reads without colour. */
export const RANK_ICON: Record<string, ReactNode> = {
  curator: <Diamond size={11} fill="currentColor" />,
  joined: <Check size={11} />,
  subscriber: <Rss size={11} />,
  viewer: <Eye size={11} />,
  unknown: <CircleHelp size={11} />,
};
