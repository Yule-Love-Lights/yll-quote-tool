// The channel between the task list and the nav badge. Small surface, but it
// carries the fix for a real staleness bug, so both halves are pinned: it must
// reach a listener in a browser, and it must not throw where there is no
// window (this suite runs the 'node' environment, which is exactly that case).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFFICE_TASKS_CHANGED, notifyOfficeTasksChanged } from './officeTasksEvents';

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('notifyOfficeTasksChanged', () => {
  it('does nothing, and throws nothing, with no window (server render)', () => {
    expect(originalWindow).toBeUndefined();
    expect(() => notifyOfficeTasksChanged()).not.toThrow();
  });

  it('dispatches the event a listening nav badge is waiting on', () => {
    const dispatchEvent = vi.fn();
    (globalThis as { window?: unknown }).window = { dispatchEvent } as unknown;

    notifyOfficeTasksChanged();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]![0] as Event;
    expect(event.type).toBe(OFFICE_TASKS_CHANGED);
  });

  it('uses a stable event name, since the nav subscribes to the string not the module', () => {
    // A rename here silently unsubscribes the badge: nothing would fail to
    // compile, the listener would just never fire again.
    expect(OFFICE_TASKS_CHANGED).toBe('office-tasks-changed');
  });
});
