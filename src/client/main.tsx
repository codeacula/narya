import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage, OverlayChatPage, OverlayNowPlayingPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';
import { ViewerWindowPage } from './pages/ViewerWindow';

function App() {
  const path = window.location.pathname;

  const isOverlay = path === '/overlay' || path === '/overlay/chat' || path === '/overlay/nowplaying';

  React.useEffect(() => {
    document.documentElement.classList.toggle('overlayPage', isOverlay);
    document.body.classList.toggle('overlayPage', isOverlay);
    return () => {
      document.documentElement.classList.remove('overlayPage');
      document.body.classList.remove('overlayPage');
    };
  }, [isOverlay]);

  if (path === '/overlay') return <OverlayPage />;
  if (path === '/overlay/chat') return <OverlayChatPage />;
  if (path === '/overlay/nowplaying') return <OverlayNowPlayingPage />;
  if (path === '/tablet') return <TabletPage />;
  if (path === '/viewer') return <ViewerWindowPage />;
  const initialPage = path === '/settings/rewards' ? 'rewards' : path === '/settings' ? 'settings' : 'dashboard';
  return <DashboardPage initialPage={initialPage} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
