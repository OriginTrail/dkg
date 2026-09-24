import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
