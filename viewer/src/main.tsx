import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { hasUnsavedChanges, flushSavesOnUnload } from './store.ts';
import './index.css';

// Warn before closing/reloading the tab while an edit is not confirmed saved
// (debounce pending, PUT in flight, or last PUT failed), and push queued PUTs
// out right away with fetch keepalive so they can outlive the page.
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsavedChanges()) return;
  flushSavesOnUnload();
  e.preventDefault();
  e.returnValue = ''; // older Chrome/Safari still need returnValue
});

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
