import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ListUnavailable, SettingsStatus } from './shared';

const render = (props: React.ComponentProps<typeof SettingsStatus>) =>
  renderToStaticMarkup(React.createElement(SettingsStatus, props));

describe('SettingsStatus', () => {
  test('its live regions exist before there is anything to say', () => {
    // A region inserted together with its text is often not announced; screen readers
    // watch regions that already exist. So an idle status still mounts both.
    const idle = render({});
    expect(idle).toContain('role="status"');
    expect(idle).toContain('role="alert"');
    // ...and draws nothing visible, so it adds no line (or gap) to the form.
    expect(idle).not.toContain('command-settings-status');
  });

  test('a message is announced politely and drawn once, hidden from the reader', () => {
    const html = render({ message: 'Sound saved' });
    expect(html).toContain('<div class="sr-only" role="status">Sound saved</div>');
    expect(html).toContain('<div class="sr-only" role="alert"></div>');
    expect(html).toContain('<div class="command-settings-status" aria-hidden="true">Sound saved</div>');
  });

  test('an error wins, is announced assertively, and takes the error style', () => {
    const html = render({ message: 'Saved', error: 'Could not save' });
    expect(html).toContain('<div class="sr-only" role="status"></div>');
    expect(html).toContain('<div class="sr-only" role="alert">Could not save</div>');
    expect(html).toContain('<div class="command-settings-status error" aria-hidden="true">Could not save</div>');
  });
});

describe('the settings feedback rule (shared.tsx)', () => {
  // A save, delete or load on a settings page reports through SettingsStatus beside
  // the form, not a toast. Content used to toast every write, and Connections showed a
  // failed save twice (toast and inline).
  test('no settings section reports through toasts', () => {
    const dir = import.meta.dir;
    const offenders = readdirSync(dir)
      .filter(name => name.endsWith('.tsx'))
      .filter(name => /useToast|pushToast/.test(readFileSync(join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('ListUnavailable', () => {
  const render = (props: React.ComponentProps<typeof ListUnavailable>) =>
    renderToStaticMarkup(React.createElement(ListUnavailable, props));

  test('offers Retry while idle', () => {
    const html = render({ title: 'Counters unavailable', onRetry: () => {} });
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('aria-disabled');
  });

  test('a retry in flight keeps the same button, marked busy but still focusable', () => {
    // `disabled` would drop keyboard focus to the page body; aria-disabled keeps it.
    const html = render({ title: 'Counters unavailable', onRetry: () => {}, retrying: true });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('>Retrying…</button>');
    expect(html).not.toMatch(/<button[^>]*\sdisabled/);
  });
});
