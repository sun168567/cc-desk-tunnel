import React from 'react';
import ReactDOM from 'react-dom/client';
import WebGate from './WebGate.tsx';
import { App } from './App.tsx';
import Launcher from './Launcher.tsx';
import { getPrefs, onPrefs } from './prefs.ts';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';
// The colours chosen in the settings, set before the page first draws.
const showTheme = () => {
  document.documentElement.dataset.theme = getPrefs().theme;
};
showTheme();
onPrefs(showTheme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.desktop?.boot?.launcher ? (
      <Launcher />
    ) : !window.desktop && !import.meta.env.DEV ? (
      <WebGate />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
