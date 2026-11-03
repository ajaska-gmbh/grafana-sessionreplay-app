import { parseLogfmt } from './logfmt';
import { exceptionLine, logLine } from './fixtures';

describe('parseLogfmt', () => {
  it('parses bare and quoted values of a real Faro line', () => {
    const fields = parseLogfmt(logLine);

    expect(fields.kind).toBe('log');
    expect(fields.message).toBe('[PPD] Twilio lifecycle');
    expect(fields.session_id).toBe('p033owWikG');
    expect(fields.browser_os).toBe('Windows 10');
    expect(fields.timestamp).toBe('2026-11-03 12:37:15.539 +0000 UTC');
  });

  it('decodes go-logfmt escapes', () => {
    const fields = parseLogfmt(exceptionLine);

    expect(fields.stacktrace).toBe(
      'Error: console.error: Error updating user state\n  at ? (https://ppd.ajaska.de/build/assets/app.js:71:2349)\n  at Array.forEach (<anonymous>:0:0)'
    );
  });

  it('round-trips JSON that was quoted for logfmt', () => {
    const payload = { type: 3, data: { text: 'He said "hi"\\ tab\there\nnew line', emoji: 'ü 😀' } };
    const fields = parseLogfmt(`event_data_event=${JSON.stringify(JSON.stringify(payload))} next=1`);

    expect(JSON.parse(fields.event_data_event)).toEqual(payload);
    expect(fields.next).toBe('1');
  });

  it('handles empty values, bare keys and unterminated quotes', () => {
    expect(parseLogfmt('a= b c="" d')).toEqual({ a: '', b: '', c: '', d: '' });
    expect(parseLogfmt('a="open')).toEqual({ a: 'open' });
  });
});
