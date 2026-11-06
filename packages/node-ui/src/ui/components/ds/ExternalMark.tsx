// Follows the text of a link that opens outside the app.
import React from 'react';
import { ArrowUpRight } from 'lucide-react';

export function ExternalMark() {
  return <ArrowUpRight className="ds-external-mark" size={12} aria-hidden="true" />;
}
