import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage, OverlayChatPage, OverlayNowPlayingPage, OverlaySoundsPage, OverlayShoutoutsPage, OverlayClipsPage, OverlayStatusPage, OverlayTextPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';
import { ViewerWindowPage } from './pages/ViewerWindow';
import { dashboardRouteFromPath } from './routing';
import { captureDashboardToken } from './auth';
import { AuthGate } from './ui/authGate';
import { ToastProvider } from './ui/notifications';
import { ServiceStatusToasts } from './ui/serviceStatus';

/**
 * Browser sources, keyed by path. This is the single source of truth for which
 * paths are overlays: membership here both selects the component and applies the
 * transparent `overlayPage` body class. Keeping the two derived from one map is
 * the point — when they were separate lists, adding an overlay to one and not
 * the other rendered the widget on the app's opaque background, which is easy to
 * miss and useless as an OBS source.
 */
const OVERLAY_PAGES: Record<string, React.ComponentType> = {
  '/overlay': OverlayPage,
  '/overlay/chat': OverlayChatPage,
  '/overlay/nowplaying': OverlayNowPlayingPage,
  '/overlay/sounds': OverlaySoundsPage,
  '/overlay/shoutouts': OverlayShoutoutsPage,
  '/overlay/clips': OverlayClipsPage,
  '/overlay/status': OverlayStatusPage,
  '/overlay/text': OverlayTextPage,
};

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const OverlayComponent = OVERLAY_PAGES[path];
  const isOverlay = Boolean(OverlayComponent);

  React.useEffect(() => {
    document.documentElement.classList.toggle('overlayPage', isOverlay);
    document.body.classList.toggle('overlayPage', isOverlay);
    return () => {
      document.documentElement.classList.remove('overlayPage');
      document.body.classList.remove('overlayPage');
    };
  }, [isOverlay]);

  // Overlays are deliberately outside the gate: an OBS browser source has no one
  // to type a token at, and must stay transparent rather than render app chrome.
  if (OverlayComponent) return <OverlayComponent />;
  if (path === '/tablet') return <AuthGate><TabletPage /></AuthGate>;
  if (path === '/viewer') return <AuthGate><ViewerWindowPage /></AuthGate>;
  const initialPage = dashboardRouteFromPath(path);
  return (
    <AuthGate>
      <ToastProvider>
        <ServiceStatusToasts />
        <DashboardPage initialPage={initialPage} />
      </ToastProvider>
    </AuthGate>
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
