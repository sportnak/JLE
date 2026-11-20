import '@fontsource/shippori-mincho/400.css';
import '@fontsource/shippori-mincho/600.css';
import '@fontsource/klee-one/400.css';
import '@fontsource/klee-one/600.css';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import './design/tokens.css';
import './design/components.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyDisplay, applyFont } from './prefs';

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light');
applyTheme();
dark.addEventListener('change', applyTheme);
applyFont();
applyDisplay();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
