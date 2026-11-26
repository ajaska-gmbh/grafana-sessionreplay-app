/**
 * Bench player: the app's real ReplayPlayer outside Grafana, fed Faro payload
 * lines (as Loki returns them) and zoom samples, with a small API for
 * Playwright to seek and to read what the replay shows.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTheme, ThemeContext } from '@grafana/data';
import { ReplayPlayer, type SeekRequest } from '../src/components/Player/ReplayPlayer';
import { PlayerClock } from '../src/lib/playerClock';
import { loadedTimeline } from '../src/lib/fixtures';
import type { ZoomSample } from '../src/lib/viewportZoom';
import type { LokiLine } from '../src/types';

export interface BenchInput {
  sessionId: string;
  lines: LokiLine[];
  zoom?: ZoomSample[];
  /** Stage size in CSS px (the player's box). */
  width?: number;
  height?: number;
}

declare global {
  interface Window {
    benchInput: BenchInput;
    bench: BenchApi;
  }
}

export interface ReplayState {
  offsetMs: number;
  /** The replayed iframe's attributes: the viewport the page is laid out in. */
  iframe: { width: number; height: number };
  wrapper: { transform: string; left: string; top: string; clipPath: string };
  /** Inside the replayed page. */
  doc: { scrollX: number; scrollY: number; clientWidth: number; innerWidth: number; innerHeight: number } | null;
  waiting: string | null;
  errors: string[];
}

export interface BenchApi {
  seek(offsetMs: number): Promise<ReplayState>;
  state(): ReplayState;
  /** Rects (in the replayed page's viewport) and ::after texts of elements matching the selector. */
  query(selector: string): Array<{ top: number; left: number; width: number; height: number; after: string }>;
  startMs: number;
  totalMs: number;
  pages: Array<{ offsetMs: number; url?: string }>;
}

const errors: string[] = [];
window.addEventListener('error', (event) => errors.push(String(event.message)));
const originalError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(' '));
  originalError(...args);
};

const input = window.benchInput;
const timeline = loadedTimeline(input.lines, input.sessionId);
const track = timeline.tracks[0];
const clock = new PlayerClock();

function iframe(): HTMLIFrameElement | null {
  return document.querySelector('.replayer-wrapper iframe');
}

function state(): ReplayState {
  const frame = iframe();
  const wrapper = document.querySelector<HTMLElement>('.replayer-wrapper');
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument;
  return {
    offsetMs: clock.get().offsetMs,
    iframe: { width: Number(frame?.getAttribute('width')), height: Number(frame?.getAttribute('height')) },
    wrapper: {
      transform: wrapper?.style.transform ?? '',
      left: wrapper?.style.left ?? '',
      top: wrapper?.style.top ?? '',
      clipPath: wrapper?.style.clipPath ?? '',
    },
    doc:
      win && doc
        ? {
            scrollX: win.scrollX,
            scrollY: win.scrollY,
            clientWidth: doc.documentElement.clientWidth,
            innerWidth: win.innerWidth,
            innerHeight: win.innerHeight,
          }
        : null,
    waiting: document.querySelector('[data-testid="data-testid player-waiting"]')?.textContent ?? null,
    errors: [...errors],
  };
}

const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function Bench() {
  const [seekRequest, setSeekRequest] = useState<SeekRequest | undefined>(undefined);
  window.bench = {
    async seek(offsetMs: number) {
      setSeekRequest({ offsetMs, nonce: Math.random() });
      await frames();
      await frames();
      return state();
    },
    state,
    query(selector) {
      const doc = iframe()?.contentDocument;
      const win = iframe()?.contentWindow;
      if (!doc || !win) {
        return [];
      }
      return [...doc.querySelectorAll(selector)].map((element) => {
        const rect = element.getBoundingClientRect();
        const after = win.getComputedStyle(element, '::after').content;
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, after };
      });
    },
    startMs: track.startMs,
    totalMs: track.endMs - track.startMs,
    pages: track.pages.map((page) => ({ offsetMs: page.timestamp - track.startMs, url: page.href })),
  };
  return (
    <div style={{ width: input.width ?? 1200, height: input.height ?? 800 }}>
      <ReplayPlayer track={track} clock={clock} zoom={input.zoom} seekRequest={seekRequest} />
    </div>
  );
}

const theme = createTheme({ colors: { mode: 'light' } });
createRoot(document.getElementById('root')!).render(
  <ThemeContext.Provider value={theme}>
    <Bench />
  </ThemeContext.Provider>
);
