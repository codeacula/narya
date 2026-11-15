import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './styles/tokens.css';
import './styles/panel.css';
import './styles/holdingStars.css';
import { DashboardPage } from './pages/Dashboard';
import { OverlayPage, OverlayChatPage, OverlayNowPlayingPage, OverlaySoundsPage, OverlayShoutoutsPage, OverlayClipsPage, OverlayStatusPage, OverlayTextPage, OverlayWindDownPage, OverlayTopBarPage, OverlayBottomBarPage, OverlayAdsPage, OverlayPinnedPage, OverlayStartingPage, OverlayBrbPage, OverlayEndingPage, OverlayUnknownPage } from './pages/Overlay';
import { TabletPage } from './pages/Tablet';
import { ViewerWindowPage } from './pages/ViewerWindow';
import { OverlayPlaceholder } from './overlayPlaceholders';
import { dashboardRouteFromPath, overlayFromPath, type OverlayName } from './routing';
import { captureDashboardToken } from './auth';
import { AuthGate } from './ui/authGate';
import { ToastProvider } from './ui/notifications';
import { ConfirmProvider } from './ui/confirm';
import { DirtyGuardProvider } from './ui/dirtyGuard';
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
  winddown: OverlayWindDownPage,
  topbar: OverlayTopBarPage,
  bottombar: OverlayBottomBarPage,
  ads: OverlayAdsPage,
  pinned: OverlayPinnedPage,
  starting: OverlayStartingPage,
  brb: OverlayBrbPage,
  ending: OverlayEndingPage,
};

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const overlay = overlayFromPath(path);
  // Membership in overlay space — NOT recognition of the widget — is what applies the
  // transparent body class, so an unrecognized /overlay/* path is still transparent and
  // chrome-free rather than being dropped onto the app's opaque background.
  const isOverlay = overlay !== null;

  React.useEffect(() => {
    document.documentElement.classList.toggle('overlay-page', isOverlay);
    document.body.classList.toggle('overlay-page', isOverlay);
    return () => {
      document.documentElement.classList.remove('overlay-page');
      document.body.classList.remove('overlay-page');
    };
  }, [isOverlay]);

  // Overlays are deliberately outside the gate: an OBS browser source has no one
  // to type a token at, and must stay transparent rather than render app chrome.
  //
  // Anything under /overlay resolves inside this block and returns. It must never reach
  // the dashboard fall-through at the bottom: a browser source still pointing at the
  // retired /overlay/alerts used to land there and render the operator's dashboard into
  // a live scene.
  //
  // OverlayPlaceholder is attached here, once, rather than inside each page: a new
  // overlay then cannot be added without its positioning outline, and the outline
  // covers the unknown page too.
  if (overlay) {
    const OverlayComponent = overlay === 'unknown' ? null : OVERLAY_PAGES[overlay];
    return (
      <>
        {OverlayComponent ? <OverlayComponent /> : <OverlayUnknownPage path={path} />}
        <OverlayPlaceholder name={overlay} />
      </>
    );
  }
  // ConfirmProvider (the shared `useConfirm()` dialog) wraps every operator surface and
  // no overlay: a browser source has no one to answer a confirm.
  if (path === '/tablet') return <AuthGate><ConfirmProvider><TabletPage /></ConfirmProvider></AuthGate>;
  if (path === '/viewer') return <AuthGate><ConfirmProvider><ViewerWindowPage /></ConfirmProvider></AuthGate>;
  const initialPage = dashboardRouteFromPath(path);
  return (
    <AuthGate>
      <ToastProvider>
        <ConfirmProvider>
          {/* Above DashboardPage, not inside it: the page's own navigation (top nav,
              settings rail, back/forward) is what asks the guard before leaving. */}
          <DirtyGuardProvider>
            <ServiceStatusToasts />
            <DashboardPage initialPage={initialPage} />
          </DirtyGuardProvider>
        </ConfirmProvider>
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
