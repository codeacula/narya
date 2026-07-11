import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage, OverlayChatPage, OverlayNowPlayingPage, OverlaySoundsPage, OverlayShoutoutsPage, OverlayClipsPage, OverlayStatusPage, OverlayTextPage, OverlayUnknownPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';
import { ViewerWindowPage } from './pages/ViewerWindow';
import { dashboardRouteFromPath, overlayFromPath, type OverlayName } from './routing';
import { captureDashboardToken } from './auth';
import { AuthGate } from './ui/authGate';
import { ToastProvider } from './ui/notifications';
import { ServiceStatusToasts } from './ui/serviceStatus';

/**
 * Browser sources, keyed by widget name. Which *paths* map to which widget lives in
 * routing.ts (`overlayFromPath`), so the mapping is unit-testable and so a retired
 * path can be aliased rather than deleted — see /overlay/alerts there.
 */
const OVERLAY_PAGES: Record<OverlayName, React.ComponentType> = {
  frame: OverlayPage,
  chat: OverlayChatPage,
  nowplaying: OverlayNowPlayingPage,
  sounds: OverlaySoundsPage,
  shoutouts: OverlayShoutoutsPage,
  clips: OverlayClipsPage,
  status: OverlayStatusPage,
  text: OverlayTextPage,
};

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const overlay = overlayFromPath(path);
  // Membership in overlay space — NOT recognition of the widget — is what applies the
  // transparent body class, so an unrecognized /overlay/* path is still transparent and
  // chrome-free rather than being dropped onto the app's opaque background.
  const isOverlay = overlay !== null;

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
  //
  // Anything under /overlay resolves inside this block and returns. It must never reach
  // the dashboard fall-through at the bottom: a browser source still pointing at the
  // retired /overlay/alerts used to land there and render the operator's dashboard into
  // a live scene.
  if (overlay === 'unknown') return <OverlayUnknownPage path={path} />;
  if (overlay) {
    const OverlayComponent = OVERLAY_PAGES[overlay];
    return <OverlayComponent />;
  }
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
