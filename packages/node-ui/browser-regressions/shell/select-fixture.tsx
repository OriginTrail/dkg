import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Select } from '../../src/ui/components/common/Select.js';

/**
 * Mounts the real Select inside the running app, so its menu is placed by the
 * app's own stylesheet. `top` puts the trigger that far from the top of the
 * viewport; the chosen value is mirrored to data-value on the host.
 */
export function mountSelect(top: number): void {
  const host = document.createElement('div');
  host.id = 'select-probe';
  host.style.cssText = `position: fixed; left: 40px; top: ${top}px; width: 240px; z-index: 10000;`;
  document.body.appendChild(host);

  const options = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label) => ({ value: label.toLowerCase(), label }));
  function Probe() {
    const [value, setValue] = useState('');
    host.dataset.value = value;
    return <Select value={value} onChange={setValue} options={options} ariaLabel="Probe select" placeholder="Choose one" />;
  }
  createRoot(host).render(<Probe />);
}
