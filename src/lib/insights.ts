import type { JourneyEvent } from './journey';

/** The shop's funnel, first to last (LP Shop telemetry/faro.ts OUTCOMES). */
export const FUNNEL_STEPS = [
  'page_view',
  'add_to_cart',
  'initiate_checkout',
  'add_payment_info',
  'checkout_blocked',
  'purchase',
] as const;

export const STEP_LABELS: Record<string, string> = {
  page_view: 'Viewed',
  add_to_cart: 'Added to cart',
  initiate_checkout: 'Checkout',
  add_payment_info: 'Payment info',
  checkout_blocked: 'Pay blocked',
  purchase: 'Purchase',
};

/** The furthest of the given steps, by funnel order (unknown steps rank lowest). */
export function furthestStep(steps: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const step of steps) {
    if (best === undefined || FUNNEL_STEPS.indexOf(step as never) > FUNNEL_STEPS.indexOf(best as never)) {
      best = step;
    }
  }
  return best;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';

export type InsightKind =
  | 'dead_click'
  | 'rage_click'
  | 'error_click'
  | 'form_invalid'
  | 'checkout_blocked'
  | 'js_error'
  | 'failed_request'
  | 'slow'
  | 'zoom'
  | 'exit';

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: Severity;
  timeMs: number;
  title: string;
  detail?: string;
  /** Where the visitor tapped (viewport px), shown on the replayed page. */
  point?: { x: number; y: number };
  /** The journey event it came from (several for a pinch zoom: the first). */
  event: JourneyEvent;
}

export const KIND_LABELS: Record<InsightKind, string> = {
  dead_click: 'Dead taps',
  rage_click: 'Rage taps',
  error_click: 'Error taps',
  form_invalid: 'Form errors',
  checkout_blocked: 'Pay blocked',
  js_error: 'JS errors',
  failed_request: 'Failed requests',
  slow: 'Slow',
  zoom: 'Pinch zooms',
  exit: 'Exits',
};

export const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];

/** Zoom samples closer than this belong to one pinch. */
const PINCH_GAP_MS = 2000;
/** A zoom above this is the visitor zooming in to read or tap; below it is noise. */
const ZOOMED_IN = 1.15;
const ZOOM_EVENT = 'viewport_zoom';

function point(event: JourneyEvent): Insight['point'] {
  const x = Number(event.attributes.event_data_x);
  const y = Number(event.attributes.event_data_y);
  return event.attributes.event_data_x && event.attributes.event_data_y && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function insight(
  event: JourneyEvent,
  kind: InsightKind,
  severity: Severity,
  title = event.title,
  detail = event.detail
) {
  return { id: `${kind}:${event.id}`, kind, severity, timeMs: event.timeMs, title, detail, point: point(event), event };
}

function failedStatus(event: JourneyEvent): string | undefined {
  const status =
    event.attributes['event_data_http.response.status_code'] ?? event.attributes['event_data_http.status_code'];
  if (status === undefined) {
    return undefined;
  }
  const code = Number(status);
  return code === 0 || code >= 400 ? status : undefined;
}

function fromEvent(event: JourneyEvent): Insight | undefined {
  const name = event.attributes.event_name ?? '';
  switch (event.category) {
    case 'frustration':
      if (name === 'dead_click') {
        return insight(event, 'dead_click', event.attributes.event_data_interactive === '1' ? 'high' : 'medium');
      }
      if (name === 'rage_click' || name === 'error_click') {
        return insight(event, name, 'high');
      }
      return insight(event, 'form_invalid', 'medium');
    case 'error':
      return insight(event, 'js_error', event.attributes.kind === 'exception' ? 'high' : 'medium');
    case 'network': {
      const status = failedStatus(event);
      return status ? insight(event, 'failed_request', 'medium', `Request failed: ${event.title}`) : undefined;
    }
    case 'navigation':
      return name === 'page_exit' ? insight(event, 'exit', 'info') : undefined;
    default:
      break;
  }
  if (name === 'checkout_blocked') {
    const reason = Object.entries(event.attributes)
      .filter(([key]) => key.startsWith('event_data_'))
      .map(([key, value]) => `${key.slice(11)}: ${value}`)
      .join(' · ');
    return insight(event, 'checkout_blocked', 'high', 'Pay button pressed, checkout blocked', reason || undefined);
  }
  if (event.attributes.type === 'web-vitals') {
    const rating = event.attributes.context_rating;
    if (rating === 'poor') {
      return insight(event, 'slow', 'medium', `Slow: ${event.title.replace(/ \(poor\)$/, '')}`);
    }
    if (rating === 'needs-improvement') {
      return insight(event, 'slow', 'low', `Sluggish: ${event.title.replace(/ \(needs-improvement\)$/, '')}`);
    }
  }
  return undefined;
}

/** One insight per pinch where the visitor zoomed in (text or buttons too small?). */
function pinches(events: readonly JourneyEvent[]): Insight[] {
  const found: Insight[] = [];
  let pinch: { first: JourneyEvent; lastMs: number; maxScale: number } | undefined;
  const close = () => {
    if (pinch && pinch.maxScale >= ZOOMED_IN) {
      const path = pinch.first.attributes.page_url
        ? new URL(pinch.first.attributes.page_url, 'https://x').pathname
        : '';
      found.push(
        insight(
          pinch.first,
          'zoom',
          'low',
          `Zoomed in to ${pinch.maxScale.toFixed(1)}×`,
          `Text or buttons may be too small here${path ? ` · ${path}` : ''}`
        )
      );
    }
    pinch = undefined;
  };
  for (const event of events) {
    if (event.attributes.event_name !== ZOOM_EVENT) {
      continue;
    }
    const scale = Number(event.attributes.event_data_scale);
    if (!Number.isFinite(scale)) {
      continue;
    }
    if (pinch && event.timeMs - pinch.lastMs > PINCH_GAP_MS) {
      close();
    }
    if (!pinch) {
      if (scale < ZOOMED_IN) {
        continue;
      }
      pinch = { first: event, lastMs: event.timeMs, maxScale: scale };
      continue;
    }
    pinch.lastMs = event.timeMs;
    pinch.maxScale = Math.max(pinch.maxScale, scale);
  }
  close();
  return found;
}

export interface SessionInsights {
  insights: Insight[];
  counts: Partial<Record<InsightKind, number>>;
  /** Funnel steps reached (session_attr_steps / the funnel events), and the furthest. */
  steps: string[];
  outcome?: string;
  /** Whether the shop's own detector ran (else dead/rage taps come from the recording). */
  detector: boolean;
  touch: boolean;
}

/**
 * Everything in a session that points at a problem or the moment the visitor
 * was lost: frustration (dead, rage and error taps, form errors), blocked pay
 * presses, JS errors, failed requests, slow vitals, pinch zooms and page exits,
 * plus the furthest funnel step. `recorded` are dead/rage taps found in the
 * recording, used only when the shop's detector did not run.
 */
export function sessionInsights(
  journey: readonly JourneyEvent[],
  recorded: readonly JourneyEvent[] = []
): SessionInsights {
  const detector = journey.some((event) => event.attributes.session_attr_insights === '1');
  const touch = journey.some((event) => event.attributes.browser_mobile === 'true');
  const insights: Insight[] = [];
  const steps = new Set<string>();
  for (const event of journey) {
    event.attributes.session_attr_steps?.split(',').forEach((step) => step && steps.add(step));
    const name = event.attributes.event_name;
    if (name && (FUNNEL_STEPS as readonly string[]).includes(name)) {
      steps.add(name);
    }
    const found = fromEvent(event);
    if (found) {
      insights.push(found);
    }
  }
  if (!detector) {
    recorded.map(fromEvent).forEach((found) => found && insights.push(found));
  }
  insights.push(...pinches(journey));
  insights.sort((a, b) => a.timeMs - b.timeMs);

  const counts: Partial<Record<InsightKind, number>> = {};
  for (const found of insights) {
    counts[found.kind] = (counts[found.kind] ?? 0) + 1;
  }
  if (steps.size > 0) {
    steps.add('page_view');
  }
  const ordered = FUNNEL_STEPS.filter((step) => steps.has(step));
  return { insights, counts, steps: ordered, outcome: furthestStep(ordered), detector, touch };
}

/** Problems only (no exits): what the counter on the Insights tab shows. */
export function problemCount(insights: readonly Insight[]): number {
  return insights.filter((found) => found.severity !== 'info').length;
}
