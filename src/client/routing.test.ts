import { expect, test } from 'bun:test';
import {
  dashboardRouteFromName,
  dashboardRouteFromPath,
  isSettingsRoute,
  overlayFromPath,
  pathForDashboardRoute,
} from './routing';

test('resolves each overlay browser source to its widget', () => {
  expect(overlayFromPath('/overlay')).toBe('frame');
  expect(overlayFromPath('/overlay/chat')).toBe('chat');
  expect(overlayFromPath('/overlay/clips')).toBe('clips');
  expect(overlayFromPath('/overlay/text')).toBe('text');
});

// The bug this file exists for: an OBS browser source still pointing at the retired
// /overlay/alerts fell through the router to the operator's DASHBOARD, putting chat,
// controls, and viewer data on stream. Anything under /overlay is a browser source
// and must never render app chrome, whatever the path says.
test('an unknown /overlay path is an overlay, never the dashboard', () => {
  expect(overlayFromPath('/overlay/nope')).toBe('unknown');
  expect(overlayFromPath('/overlay/typo/deeper')).toBe('unknown');
});

// Alerts became Actions: the banner is a show_text step, which lands on /overlay/text.
// The alias keeps the operator's existing "[Web] Subs" source working without them
// re-editing a scene collection. It maps to text ONLY — the alert's sound and clip are
// a play_media step, and /overlay/clips is already in the scene playing them, so
// rendering media here too would play every alert twice.
test('the retired /overlay/alerts source still works, as the text overlay', () => {
  expect(overlayFromPath('/overlay/alerts')).toBe('text');
});

test('trailing slashes and non-overlay paths are unaffected', () => {
  expect(overlayFromPath('/overlay/chat/')).toBe('chat');
  expect(overlayFromPath('/overlays')).toBeNull();
  expect(overlayFromPath('/settings')).toBeNull();
  expect(overlayFromPath('/')).toBeNull();
});

test('dashboard routing still resolves real pages', () => {
  expect(dashboardRouteFromPath('/settings')).toBe('settings');
  expect(dashboardRouteFromPath('/')).toBe('dashboard');
});

// Every settings section is its own URL, so the rail is linkable and the back button
// walks between sections rather than out of settings entirely.
test('each settings section resolves from its path and back to it', () => {
  const sections = [
    ['/settings', 'settings'],
    ['/settings/go-live', 'golive'],
    ['/settings/categories', 'categories'],
    ['/settings/rewards', 'rewards'],
    ['/settings/quotes', 'quotes'],
    ['/settings/actions', 'actions'],
    ['/settings/automation', 'automation'],
    ['/settings/modules', 'modules'],
    ['/settings/counters', 'counters'],
    ['/settings/content', 'content'],
    ['/settings/speech', 'speech'],
    ['/settings/ai', 'ai'],
  ] as const;
  for (const [path, route] of sections) {
    expect(dashboardRouteFromPath(path)).toBe(route);
    expect(pathForDashboardRoute(route)).toBe(path);
    expect(isSettingsRoute(route)).toBe(true);
  }
});

// The top nav's settings link lights for any section, so it can't go dark while the
// operator is standing in one of them.
test('only settings sections count as settings routes', () => {
  expect(isSettingsRoute('dashboard')).toBe(false);
  expect(isSettingsRoute('viewers')).toBe(false);
  expect(isSettingsRoute('viewer')).toBe(false);
});

// A nav click hands over a bare string. An unknown one lands on the dashboard rather
// than pushing a URL that resolves to nothing.
test('an unknown route name falls back to the dashboard', () => {
  expect(dashboardRouteFromName('speech')).toBe('speech');
  expect(dashboardRouteFromName('nope')).toBe('dashboard');
  expect(dashboardRouteFromPath('/settings/nope')).toBe('dashboard');
});
