import type { ReactNode } from 'react';
import { Check, CircleHelp, Diamond, Eye, Rss } from 'lucide-react';

/** The icon on the "Your role" pill, so the pill reads without colour. */
export const RANK_ICON: Record<string, ReactNode> = {
  curator: <Diamond size={12} fill="currentColor" />,
  joined: <Check size={12} />,
  subscriber: <Rss size={12} />,
  viewer: <Eye size={12} />,
  unknown: <CircleHelp size={12} />,
};
