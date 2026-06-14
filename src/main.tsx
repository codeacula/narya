import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';

function App() {
  const path = window.location.pathname;

  React.useEffect(() => {
    document.documentElement.classList.toggle('overlayPage', path === '/overlay');
    document.body.classList.toggle('overlayPage', path === '/overlay');
    return () => {
      document.documentElement.classList.remove('overlayPage');
      document.body.classList.remove('overlayPage');
    };
  }, [path]);

  if (path === '/overlay') return <OverlayPage />;
  if (path === '/tablet') return <TabletPage />;
  return <DashboardPage />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
