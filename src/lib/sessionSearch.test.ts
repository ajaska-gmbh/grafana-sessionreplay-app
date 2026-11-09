import { eventMatches, searchValue, sessionSearchQuery, validSearchFields } from './sessionSearch';

describe('session search', () => {
  it('looks a value up exactly in the configured event attributes, quoted', () => {
    expect(sessionSearchQuery(['lead_id', 'crm_lead_id'], '48211', [], 86400)).toBe(
      'sum by (session_id) (count_over_time({source="faro"} |= "kind=event" |= "48211" | logfmt | event_data_lead_id="48211" or event_data_crm_lead_id="48211" [86400s]))'
    );
  });

  it('narrows to the selected apps', () => {
    expect(sessionSearchQuery(['lead_id'], 'x', ['ppd-leads-frontend'], 60)).toContain(
      '{source="faro"} |= " app_name=ppd-leads-frontend " | app_name=~"ppd-leads-frontend" |= "kind=event"'
    );
  });

  it('cannot be made to run another query by what is typed', () => {
    const query = sessionSearchQuery(['lead_id'], '" or session_id=~".+', [], 60);
    expect(query).toContain('|= "\\" or session_id=~\\".+"');
    expect(query).toContain('event_data_lead_id="\\" or session_id=~\\".+"');
  });

  it('only takes attribute names as fields', () => {
    expect(validSearchFields(['lead_id', 'crm_lead_id', 'lead_id', 'bad-name', 'x"y', 7, ''])).toEqual([
      'lead_id',
      'crm_lead_id',
    ]);
    expect(validSearchFields(undefined)).toEqual([]);
  });

  it('searches for nothing blank or overlong', () => {
    expect(searchValue('  ')).toBeUndefined();
    expect(searchValue(' 42 ')).toBe('42');
    expect(searchValue('x'.repeat(201))).toBeUndefined();
  });

  it('tells which events carry the value', () => {
    expect(eventMatches({ event_data_crm_lead_id: '42' }, ['lead_id', 'crm_lead_id'], '42')).toBe(true);
    expect(eventMatches({ event_data_crm_lead_id: '421' }, ['crm_lead_id'], '42')).toBe(false);
    expect(eventMatches({ event_data_crm_lead_id: '42' }, ['crm_lead_id'], undefined)).toBe(false);
  });
});
