import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';
import { activateMarketplaceFromUrl } from './marketplace/tabs.js';
import './styles.css';

// `?marketplace` turns the marketplace section on, once, before anything renders or routes.
activateMarketplaceFromUrl();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
