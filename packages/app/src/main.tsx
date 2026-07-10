import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { appConfig } from './config.js';
import { TransportProvider } from './transport/context.js';
import { UpdateGate } from './components/update-gate.js';
import './styles.css';

document.title = appConfig.name;
document.documentElement.style.setProperty('--raccoon-wallpaper', appConfig.wallpaper);
document.documentElement.style.setProperty('--raccoon-outgoing', appConfig.outgoing);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js');
  });
}

createRoot(document.getElementById('root')!).render(
  <TransportProvider>
    <UpdateGate />
    <App />
  </TransportProvider>,
);
