import { expect, test } from 'bun:test';
import { dashboardRouteFromPath, overlayFromPath } from './routing';

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
