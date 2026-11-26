/**
 * Bench recorder, injected into the bench's test pages: rrweb with the
 * options LP Shop's storefront gives Faro's ReplayInstrumentation
 * (resources/js/telemetry/faro.ts), the storefront's viewport_zoom samples,
 * and the ground truth the replay is compared with.
 */
import { record } from '@grafana/rrweb';
import type { eventWithTime } from '@grafana/rrweb-types';

export interface Truth {
  label: string;
  timestamp: number;
  layoutWidth: number;
  layoutHeight: number;
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  scale: number;
  /** Rects of [data-bench] elements in the layout viewport, and their data-replay-text. */
  elements: Record<string, { top: number; left: number; width: number; height: number; text: string | null }>;
}

export interface ZoomOut {
  timeMs: number;
  scale: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  layoutWidth: number;
  layoutHeight: number;
}

declare global {
  interface Window {
    benchEvents: eventWithTime[];
    benchZoom: ZoomOut[];
    benchTruth: Truth[];
    benchMark: (label: string) => Truth;
  }
}

window.benchEvents = [];
window.benchZoom = [];
window.benchTruth = [];

record({
  emit(event) {
    window.benchEvents.push(event);
  },
  maskAllInputs: false,
  maskInputOptions: { password: true, text: true, tel: true, number: true },
  maskInputFn: (text, element) =>
    element?.getAttribute('type') === 'password' ||
    /(^|\s)cc-(number|csc|exp)/.test(element?.getAttribute('autocomplete') ?? '')
      ? '*'.repeat(text.length)
      : text,
  maskTextSelector: '.grafana-mask',
  inlineStylesheet: true,
  recordCrossOriginIframes: false,
});

// The storefront's zoom samples (resources/js/telemetry/faro.ts recordZoom), unthrottled.
const viewport = window.visualViewport!;
let first = true;
let last = { scale: 1, offsetLeft: 0, offsetTop: 0, width: viewport.width, height: viewport.height };
const check = () => {
  const next = {
    scale: viewport.scale,
    offsetLeft: viewport.offsetLeft,
    offsetTop: viewport.offsetTop,
    width: viewport.width,
    height: viewport.height,
  };
  const unzoomed = Math.abs(next.scale - 1) < 0.01;
  const wasUnzoomed = Math.abs(last.scale - 1) < 0.01;
  const changed =
    unzoomed || wasUnzoomed
      ? unzoomed !== wasUnzoomed
      : Math.abs(next.scale - last.scale) >= 0.01 * last.scale ||
        (['offsetLeft', 'offsetTop', 'width', 'height'] as const).some((key) => Math.abs(next[key] - last[key]) >= 2);
  // A page wider than the screen opens zoomed out (Chromium even reports scale 1 then): said once at load.
  const overflowing = first && document.documentElement.clientWidth + 1 < window.innerWidth;
  first = false;
  if (!changed && !overflowing) {
    return;
  }
  last = next;
  const root = document.documentElement;
  window.benchZoom.push({
    timeMs: Date.now(),
    scale: Math.round(next.scale * 1000) / 1000,
    offsetLeft: Math.round(next.offsetLeft),
    offsetTop: Math.round(next.offsetTop),
    width: Math.round(next.width),
    height: Math.round(next.height),
    layoutWidth: root.clientWidth,
    layoutHeight: root.clientHeight,
  });
};
viewport.addEventListener('resize', check);
viewport.addEventListener('scroll', check);
// Faro starts after the load event, after rrweb's first snapshot: so does the first sample.
const start = () => setTimeout(check, 50);
if (document.readyState === 'complete') {
  start();
} else {
  window.addEventListener('load', start, { once: true });
}

window.benchMark = (label: string) => {
  const root = document.documentElement;
  const elements: Truth['elements'] = {};
  document.querySelectorAll<HTMLElement>('[data-bench]').forEach((element) => {
    const rect = element.getBoundingClientRect();
    elements[element.dataset.bench!] = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      text: element.getAttribute('data-replay-text'),
    };
  });
  const truth: Truth = {
    label,
    timestamp: Date.now(),
    layoutWidth: root.clientWidth,
    layoutHeight: root.clientHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scale: viewport.scale,
    elements,
  };
  window.benchTruth.push(truth);
  return truth;
};
