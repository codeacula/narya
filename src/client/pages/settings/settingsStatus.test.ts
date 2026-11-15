import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsStatus } from './shared';

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
