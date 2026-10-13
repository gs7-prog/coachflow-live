import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Makes BodUp installable as a web app: home screen icon, full screen, no browser bars.
// Adds the links from code, so public/index.html does not need editing.
function addAppLinks() {
  const link = (rel, href) => {
    const el = document.createElement('link');
    el.rel = rel;
    el.href = href;
    document.head.appendChild(el);
  };
  const meta = (name, content) => {
    const el = document.createElement('meta');
    el.name = name;
    el.content = content;
    document.head.appendChild(el);
  };
  link('manifest', '/manifest.json');
  link('apple-touch-icon', '/icon-192.png');
  meta('theme-color', '#4f46e5');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-title', 'BodUp');
}
addAppLinks();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// The service worker lets the browser offer the install prompt. It runs on the live (https) site.
if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.error('Service worker not registered:', err);
    });
  });
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
reportWebVitals();
