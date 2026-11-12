'use client';
import { BASE_PATH } from '@/lib/site';
import type { FrameEvent, FrameRequest } from '@/src/runner/protocol';

/**
 * The page side of "Edit and run" (`src/runner/protocol.ts`): one hidden sandboxed iframe per
 * page, created on the first Run. Events are filtered to that iframe's window, so no other frame
 * can speak for it.
 */
type Listener = (event: Exclude<FrameEvent, { type: 'ready' }>) => void;

interface Runner {
  run(code: string, listener: Listener): number;
  stop(id: number): void;
}

let pending: Promise<Runner> | null = null;
let nextId = 1;

function base(): string {
  return document.documentElement.dataset['tfBase'] ?? BASE_PATH;
}

export function runner(): Promise<Runner> {
  pending ??= new Promise<Runner>((resolve, reject) => {
    const frame = document.createElement('iframe');
    // `allow-scripts` without `allow-same-origin`: an opaque origin that cannot reach this page.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Sandboxed example runner');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.src = `${base()}/runtime/runner`;
    const listeners = new Map<number, Listener>();
    const post = (request: FrameRequest) => frame.contentWindow?.postMessage(request, '*');
    const timeout = window.setTimeout(() => {
      pending = null;
      frame.remove();
      reject(new Error('The sandbox did not start. Reload the page and try again.'));
    }, 15_000);
    window.addEventListener('message', (message: MessageEvent<FrameEvent>) => {
      if (message.source !== frame.contentWindow || typeof message.data !== 'object') return;
      const event = message.data;
      if (event.type === 'ready') {
        window.clearTimeout(timeout);
        resolve({
          run(code, listener) {
            const id = nextId++;
            listeners.set(id, listener);
            post({ type: 'run', id, code });
            return id;
          },
          stop(id) {
            post({ type: 'stop', id });
          },
        });
        return;
      }
      const listener = listeners.get(event.id);
      if (!listener) return;
      // Late output and late errors can follow `done`; a failure is always the last event.
      if (event.type === 'failed') listeners.delete(event.id);
      listener(event);
    });
    document.body.append(frame);
  });
  return pending;
}
