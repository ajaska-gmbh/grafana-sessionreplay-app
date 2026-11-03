jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { appFilter, eventLineFilter, regexEscape, sessionLineFilter, STREAMS } from './logql';

describe('logql', () => {
  it('uses only the fixed Faro streams', () => {
    expect(Object.values(STREAMS)).toEqual([
      '{source="faro"}',
      '{source="faro_replay", replay="marker"}',
      '{source="faro_replay", replay="payload"}',
    ]);
  });

  it('filters apps by structured metadata, escaping regex characters', () => {
    expect(appFilter([])).toBe('');
    expect(appFilter(['ppd-leads-frontend', 'a.b'])).toBe(' | app_name=~"ppd-leads-frontend|a\\\\.b"');
    expect(regexEscape('a+b(c)')).toBe('a\\+b\\(c\\)');
  });

  it('builds quoted line filters', () => {
    expect(sessionLineFilter('abc"x')).toBe(' |= "session_id=abc\\"x"');
    expect(eventLineFilter('faro.session_recording.started')).toBe(' |= "event_name=faro.session_recording.started"');
  });
});
