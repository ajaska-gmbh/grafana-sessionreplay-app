import type { eventWithTime } from '@grafana/rrweb-types';
import type { JourneyEvent } from './journey';

/** rrweb EventType and IncrementalSource values read here. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const SOURCE_MUTATION = 0;
const SOURCE_MOUSE_INTERACTION = 2;
const SOURCE_SCROLL = 3;
const SOURCE_INPUT = 5;
const SOURCE_MEDIA = 7;
const INTERACTION_CLICK = 2;
const INTERACTION_FOCUS = 5;
const NODE_ELEMENT = 2;
const NODE_TEXT = 3;

/** A click with no visible response this long after it is dead (as the shop's detector). */
export const DEAD_AFTER_MS = 1000;
/** Rage: this many clicks within RAGE_WINDOW_MS, each within RAGE_RADIUS_PX of the first. */
export const RAGE_CLICKS = 3;
export const RAGE_WINDOW_MS = 1000;
export const RAGE_RADIUS_PX = 40;
const LABEL_MAX = 60;

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  childNodes?: SerializedNode[];
  textContent?: string;
}

interface Node {
  tag?: string;
  attributes: Record<string, string | number | boolean | null>;
  parent?: number;
  children: number[];
  text?: string;
}

/** A light copy of the recorded DOM: enough to name what was clicked. */
class NodeMap {
  private nodes = new Map<number, Node>();

  reset(root: SerializedNode) {
    this.nodes.clear();
    this.add(root, undefined);
  }

  add(node: SerializedNode, parent: number | undefined) {
    const entry: Node = {
      tag: node.type === NODE_ELEMENT ? node.tagName?.toLowerCase() : undefined,
      attributes: node.attributes ?? {},
      parent,
      children: [],
      text: node.type === NODE_TEXT ? node.textContent : undefined,
    };
    this.nodes.set(node.id, entry);
    if (parent !== undefined) {
      this.nodes.get(parent)?.children.push(node.id);
    }
    for (const child of node.childNodes ?? []) {
      this.add(child, node.id);
    }
  }

  get(id: number): Node | undefined {
    return this.nodes.get(id);
  }

  text(id: number, budget = { left: 400 }): string {
    const node = this.nodes.get(id);
    if (!node || budget.left <= 0 || node.tag === 'script' || node.tag === 'style') {
      return '';
    }
    if (node.text !== undefined) {
      budget.left -= node.text.length;
      return node.text;
    }
    return node.children.map((child) => this.text(child, budget)).join(' ');
  }
}

const CLICKABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);
const CLICKABLE_ROLES = new Set(['button', 'link', 'tab', 'checkbox', 'radio', 'menuitem', 'switch', 'option']);
/** Clicking these answers by focusing or opening natively: no DOM change is expected. */
const SELF_ANSWERING_TAGS = new Set(['input', 'textarea', 'select', 'label', 'iframe', 'video', 'audio']);

function isClickable(node: Node): boolean {
  return (
    CLICKABLE_TAGS.has(node.tag ?? '') ||
    CLICKABLE_ROLES.has(String(node.attributes.role ?? '')) ||
    node.attributes.onclick !== undefined
  );
}

function clean(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > LABEL_MAX ? `${collapsed.slice(0, LABEL_MAX - 1)}…` : collapsed;
}

interface Target {
  label?: string;
  tag?: string;
  interactive: boolean;
  selfAnswering: boolean;
}

/** What the click hit: the nearest clickable ancestor (4 levels), named by its label or text. */
function describe(nodes: NodeMap, id: number): Target {
  let current = nodes.get(id);
  let currentId: number | undefined = id;
  let hit: { node: Node; id: number } | undefined;
  /** The clicked element (the parent when a text node was hit). */
  let element: { node: Node; id: number } | undefined;
  for (let depth = 0; current && currentId !== undefined && depth < 5; depth++) {
    if (current.tag && !element) {
      element = { node: current, id: currentId };
    }
    if (isClickable(current)) {
      hit = { node: current, id: currentId };
      break;
    }
    currentId = current.parent;
    current = currentId === undefined ? undefined : nodes.get(currentId);
  }
  const clicked = element?.node;
  const named = hit ?? element;
  if (!named) {
    return { interactive: false, selfAnswering: false };
  }
  const { attributes } = named.node;
  const label = clean(
    String(attributes['aria-label'] ?? '') ||
      nodes.text(named.id) ||
      String(attributes.alt ?? attributes.title ?? attributes.placeholder ?? '')
  );
  return {
    label: label || undefined,
    tag: named.node.tag,
    interactive: Boolean(hit),
    selfAnswering: SELF_ANSWERING_TAGS.has(clicked?.tag ?? '') || SELF_ANSWERING_TAGS.has(hit?.node.tag ?? ''),
  };
}

interface Click {
  timeMs: number;
  id: number;
  x: number;
  y: number;
}

function respondsTo(event: eventWithTime, click: Click): boolean {
  if (event.type === META || event.type === FULL_SNAPSHOT) {
    return true;
  }
  if (event.type !== INCREMENTAL) {
    return false;
  }
  const data = event.data as { source?: number; type?: number; id?: number };
  switch (data.source) {
    case SOURCE_MUTATION:
    case SOURCE_SCROLL:
    case SOURCE_INPUT:
    case SOURCE_MEDIA:
      return true;
    case SOURCE_MOUSE_INTERACTION:
      return data.type === INTERACTION_FOCUS && data.id !== click.id;
    default:
      return false;
  }
}

function frustration(
  kind: 'dead_click' | 'rage_click',
  click: Click,
  target: Target,
  touch: boolean,
  count?: number
): JourneyEvent {
  const tap = touch ? 'tap' : 'click';
  const what = target.label ? `“${target.label}”${target.tag ? ` (${target.tag})` : ''}` : (target.tag ?? 'the page');
  const title = kind === 'rage_click' ? `Rage ${tap}: ${count}× on ${what}` : `Dead ${tap} on ${what}`;
  const detail =
    kind === 'rage_click'
      ? 'Found in the recording'
      : target.interactive
        ? 'Looks clickable, nothing happened within 1 s (found in the recording)'
        : 'Not clickable: the visitor expected it to be (found in the recording)';
  return {
    id: `recorded:${kind}:${click.timeMs}:${click.id}`,
    timeMs: click.timeMs,
    category: 'frustration',
    title,
    detail,
    attributes: {
      event_name: kind,
      source: 'recording',
      event_data_x: String(Math.round(click.x)),
      event_data_y: String(Math.round(click.y)),
      event_data_label: target.label ?? '',
      event_data_tag: target.tag ?? '',
      event_data_interactive: target.interactive ? '1' : '0',
      ...(count !== undefined ? { event_data_count: String(count) } : {}),
      ...(touch ? { browser_mobile: 'true' } : {}),
    },
  };
}

/**
 * Dead and rage clicks found in recorded rrweb events (sorted by time), for
 * recordings made without the shop's own detector. A click is dead when no DOM
 * change, scroll, input, focus elsewhere or page load follows within
 * DEAD_AFTER_MS; clicks on fields and labels (they focus) never are. The
 * events must start with their snapshot for the clicked element to be named.
 */
export function recordedFrustration(events: readonly eventWithTime[], touch: boolean): JourneyEvent[] {
  const nodes = new NodeMap();
  const found: JourneyEvent[] = [];
  const clicks: Array<{ click: Click; target: Target; index: number }> = [];

  events.forEach((event, index) => {
    if (event.type === FULL_SNAPSHOT) {
      nodes.reset((event.data as { node: SerializedNode }).node);
      return;
    }
    if (event.type !== INCREMENTAL) {
      return;
    }
    const data = event.data as {
      source?: number;
      type?: number;
      id?: number;
      x?: number;
      y?: number;
      adds?: Array<{ parentId: number; node: SerializedNode }>;
    };
    if (data.source === SOURCE_MUTATION) {
      data.adds?.forEach((add) => nodes.add(add.node, add.parentId));
    } else if (data.source === SOURCE_MOUSE_INTERACTION && data.type === INTERACTION_CLICK && data.id !== undefined) {
      const click = { timeMs: event.timestamp, id: data.id, x: data.x ?? 0, y: data.y ?? 0 };
      clicks.push({ click, target: describe(nodes, data.id), index });
    }
  });

  const inRage = new Set<number>();
  for (let start = 0; start < clicks.length; start++) {
    if (inRage.has(start)) {
      continue;
    }
    const first = clicks[start].click;
    let end = start;
    while (
      end + 1 < clicks.length &&
      clicks[end + 1].click.timeMs - first.timeMs <= RAGE_WINDOW_MS &&
      Math.hypot(clicks[end + 1].click.x - first.x, clicks[end + 1].click.y - first.y) <= RAGE_RADIUS_PX
    ) {
      end++;
    }
    const count = end - start + 1;
    if (count >= RAGE_CLICKS) {
      for (let index = start; index <= end; index++) {
        inRage.add(index);
      }
      found.push(frustration('rage_click', first, clicks[start].target, touch, count));
    }
  }

  clicks.forEach(({ click, target, index }, position) => {
    if (inRage.has(position) || target.selfAnswering) {
      return;
    }
    const last = events.at(-1);
    // A click this close to the end of what is loaded cannot be judged yet.
    if (!last || last.timestamp < click.timeMs + DEAD_AFTER_MS) {
      return;
    }
    for (let next = index + 1; next < events.length; next++) {
      const event = events[next];
      if (event.timestamp > click.timeMs + DEAD_AFTER_MS) {
        break;
      }
      if (respondsTo(event, click)) {
        return;
      }
    }
    found.push(frustration('dead_click', click, target, touch));
  });

  return found.sort((a, b) => a.timeMs - b.timeMs);
}
