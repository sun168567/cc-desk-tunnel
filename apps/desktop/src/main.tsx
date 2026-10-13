import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';

// Synchronize theme early to avoid flashes of mismatched background color.
try {
  const saved = JSON.parse(localStorage.getItem('proxy-prefs') ?? '{}');
  const theme = saved?.theme === 'dark' || saved?.theme === 'light' ? saved.theme : 'system';
  const effective =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
  void window.desktop?.setTheme?.(effective);
} catch {}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
