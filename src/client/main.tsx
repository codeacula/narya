import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage, OverlayChatPage, OverlayNowPlayingPage, OverlaySoundsPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';
import { ViewerWindowPage } from './pages/ViewerWindow';
import { dashboardRouteFromPath } from './routing';
import { captureDashboardToken } from './auth';
import { ToastProvider } from './ui/notifications';
import { ServiceStatusToasts } from './ui/serviceStatus';

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';

  const isOverlay = path === '/overlay'
    || path === '/overlay/chat'
    || path === '/overlay/nowplaying'
    || path === '/overlay/sounds';

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
  if (path === '/overlay/sounds') return <OverlaySoundsPage />;
  if (path === '/tablet') return <TabletPage />;
  if (path === '/viewer') return <ViewerWindowPage />;
  const initialPage = dashboardRouteFromPath(path);
  return (
    <ToastProvider>
      <ServiceStatusToasts />
      <DashboardPage initialPage={initialPage} />
    </ToastProvider>
  );
}

// Capture a ?token= from the URL (persist + strip) before anything renders or
// opens the WebSocket, so the token is available to every request.
captureDashboardToken();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
