import { buildJourney, exitDetail, targetText, toJourneyEvent, type JourneyEvent } from './journey';
import { furthestStep, problemCount, sessionInsights } from './insights';

const SESSION = 'shopSess1';
const base = (time: string, extra = '') =>
  `timestamp="2026-11-26 10:00:${time} +0000 UTC" ${extra} app_name=lp-shop-storefront session_id=${SESSION} ` +
  'browser_mobile=true session_attr_insights=1 session_attr_outcome=initiate_checkout ' +
  'session_attr_steps=page_view,add_to_cart,initiate_checkout page_url=https://shop.example/p/serum';

const event = (time: string, name: string, data = '') => base(time, `kind=event event_name=${name} ${data}`);

const lines = [
  event(
    '01.000',
    'dead_click',
    'event_data_label="Buy now" event_data_tag=button event_data_interactive=1 event_data_x=120 event_data_y=340 event_data_page_path=/p/serum'
  ),
  event(
    '02.000',
    'dead_click',
    'event_data_target="main > img.hero" event_data_tag=img event_data_interactive=0 event_data_x=5 event_data_y=6'
  ),
  event(
    '03.000',
    'rage_click',
    'event_data_count=4 event_data_label="Size M" event_data_tag=button event_data_x=1 event_data_y=2'
  ),
  event('04.000', 'error_click', 'event_data_label=Pay event_data_message="TypeError: x is undefined"'),
  event(
    '05.000',
    'form_invalid',
    'event_data_field=email event_data_label=Email event_data_reason="Please fill in this field."'
  ),
  event('06.000', 'checkout_blocked', 'event_data_missing=email'),
  event(
    '07.000',
    'page_exit',
    'event_data_page_path=/checkout event_data_time_ms=42400 event_data_scroll_depth=35 event_data_last_click="Buy now" event_data_last_field=email event_data_last_field_filled=0'
  ),
  event('08.000', 'add_to_cart'),
  event(
    '09.000',
    'faro.tracing.fetch',
    'event_data_http.request.method=POST event_data_http.response.status_code=500 event_data_url.full=https://shop.example/api/checkout'
  ),
  event('09.500', 'faro.tracing.fetch', 'event_data_http.request.method=GET event_data_http.response.status_code=200'),
  event('09.600', 'faro.tracing.fetch', 'event_data_http.request.method=GET'),
  base('10.000', 'kind=measurement type=web-vitals context_rating=poor value_lcp=4200'),
  base('10.500', 'kind=measurement type=web-vitals context_rating=needs-improvement value_inp=300'),
  base('10.700', 'kind=measurement type=web-vitals context_rating=good value_cls=0.01'),
  base('11.000', 'kind=exception type=TypeError value="boom"'),
  base('11.500', 'kind=log level=warn message="careful"'),
  // A pinch to 2x, a sample too small to count, then a separate small zoom (ignored).
  event('12.000', 'viewport_zoom', 'event_data_scale=1.6'),
  event('12.500', 'viewport_zoom', 'event_data_scale=2.04'),
  event('13.000', 'viewport_zoom', 'event_data_scale=1'),
  event('20.000', 'viewport_zoom', 'event_data_scale=1.05'),
  event('20.100', 'viewport_zoom', 'event_data_scale=nope'),
  event('30.000', 'viewport_zoom', 'event_data_scale=1.3'),
].map((line, index) => ({ tsNs: `${1764151200000 + index}000000`, line }));

describe('journey: the shop’s frustration events', () => {
  const journey = buildJourney(lines, SESSION);
  const byName = (name: string) => journey.filter((entry) => entry.attributes.event_name === name);

  it('names taps by their text and kind', () => {
    const [deadButton, deadImage] = byName('dead_click');
    expect(deadButton).toMatchObject({
      category: 'frustration',
      title: 'Dead tap on “Buy now” (button)',
      detail: 'Looks clickable, nothing happened within 1 s · /p/serum',
    });
    expect(deadImage.title).toBe('Dead tap on main > img.hero');
    expect(deadImage.detail).toBe('Not clickable: the visitor expected it to be');
    expect(byName('rage_click')[0].title).toBe('Rage tap: 4× on “Size M” (button)');
    expect(byName('error_click')[0]).toMatchObject({
      title: 'Error after tap on “Pay”',
      detail: 'TypeError: x is undefined',
    });
    expect(byName('form_invalid')[0]).toMatchObject({
      title: 'Form error: Email',
      detail: 'Please fill in this field.',
    });
    expect(byName('page_exit')[0]).toMatchObject({
      category: 'navigation',
      title: 'Left /checkout',
      detail: 'After 0:42 · saw 35 % of the page · last tap “Buy now” · last field email (empty)',
    });
  });

  it('falls back where details are missing', () => {
    const one = (data: string) => toJourneyEvent('1000000', `kind=event session_id=s ${data}`, 's')!;
    expect(one('event_name=rage_click').title).toBe('Rage click: several× on the page');
    expect(one('event_name=form_invalid').title).toBe('Form error: a field');
    expect(one('event_name=form_invalid').detail).toBeUndefined();
    expect(one('event_name=page_exit')).toMatchObject({ title: 'Left the page', detail: '' });
    expect(targetText({ event_data_label: 'Go' })).toBe('“Go”');
    expect(targetText({ event_data_tag: 'div' })).toBe('div');
    expect(exitDetail({ event_data_last_field: 'zip', event_data_last_field_filled: '1' })).toBe(
      'Last field zip (filled)'
    );
  });
});

describe('sessionInsights', () => {
  const journey = buildJourney(lines, SESSION);

  it('lists every problem in time order with its severity and tap point', () => {
    const { insights, counts, detector, touch } = sessionInsights(journey);
    expect(detector).toBe(true);
    expect(touch).toBe(true);
    expect(insights.map((found) => [found.kind, found.severity])).toEqual([
      ['dead_click', 'high'],
      ['dead_click', 'medium'],
      ['rage_click', 'high'],
      ['error_click', 'high'],
      ['form_invalid', 'medium'],
      ['checkout_blocked', 'high'],
      ['exit', 'info'],
      ['failed_request', 'medium'],
      ['slow', 'medium'],
      ['slow', 'low'],
      ['js_error', 'high'],
      ['js_error', 'medium'],
      ['zoom', 'low'],
      ['zoom', 'low'],
    ]);
    expect(insights[0].point).toEqual({ x: 120, y: 340 });
    expect(insights[3].point).toBeUndefined();
    expect(insights[5]).toMatchObject({ title: 'Pay button pressed, checkout blocked', detail: 'missing: email' });
    expect(insights[7].title).toBe('Request failed: Fetch request (POST 500)');
    expect(insights[8].title).toBe('Slow: Largest Contentful Paint: 4200 ms');
    expect(insights[9].title).toBe('Sluggish: Interaction to Next Paint: 300 ms');
    expect(insights[12]).toMatchObject({
      title: 'Zoomed in to 2.0×',
      detail: 'Text or buttons may be too small here · /p/serum',
    });
    expect(counts).toMatchObject({ dead_click: 2, zoom: 2, exit: 1 });
    expect(problemCount(insights)).toBe(13);
  });

  it('takes the funnel from the session attributes and the funnel events', () => {
    const summary = sessionInsights(journey);
    expect(summary.steps).toEqual(['page_view', 'add_to_cart', 'initiate_checkout', 'checkout_blocked']);
    expect(summary.outcome).toBe('checkout_blocked');
    expect(sessionInsights([]).steps).toEqual([]);
    expect(sessionInsights([]).outcome).toBeUndefined();
  });

  it('uses taps found in the recording only without the shop’s detector', () => {
    const recorded: JourneyEvent = {
      id: 'recorded:dead',
      timeMs: 1,
      category: 'frustration',
      title: 'Dead click on “x”',
      attributes: { event_name: 'dead_click', event_data_interactive: '1', source: 'recording' },
    };
    expect(sessionInsights(journey, [recorded]).insights.some((found) => found.id.includes('recorded'))).toBe(false);
    const without = sessionInsights([], [recorded]);
    expect(without.detector).toBe(false);
    expect(without.touch).toBe(false);
    expect(without.insights.map((found) => found.kind)).toEqual(['dead_click']);
  });

  it('ranks steps by the funnel', () => {
    expect(furthestStep(['purchase', 'page_view'])).toBe('purchase');
    expect(furthestStep(['unknown', 'add_to_cart'])).toBe('add_to_cart');
    expect(furthestStep([])).toBeUndefined();
  });
});
