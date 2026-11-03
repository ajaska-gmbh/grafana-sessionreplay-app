jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { audioLevelLine, idleMicLevelLine, idleMicSilentLine, logLine, micSilentLine, webVitalLine } from './fixtures';
import { hiddenMeasurementsLineFilter, journeyQuery } from './journeyQuery';

/** What Loki keeps for a `!~ "<re>"` line filter (RE2 and JS agree on this pattern). */
function keptBy(filter: string, line: string): boolean {
  const pattern = JSON.parse(filter.replace(/^ !~ /, '')) as string;
  return !new RegExp(pattern).test(line);
}

describe('journeyQuery', () => {
  it("queries a session's journey without the per-second audio level measurements", () => {
    expect(journeyQuery('abc')).toBe(
      '{source="faro"} |= "session_id=abc" !~ "(^| )type=(twilio_audio_level|telnyx_audio_level|twilio_mic_level_idle)( |$)"'
    );
  });

  it('drops exactly the hidden measurement lines', () => {
    const filter = hiddenMeasurementsLineFilter();

    expect(keptBy(filter, audioLevelLine('twilio_audio_level'))).toBe(false);
    expect(keptBy(filter, audioLevelLine('telnyx_audio_level'))).toBe(false);
    expect(keptBy(filter, idleMicLevelLine)).toBe(false);

    // Their silence warnings, other measurements and look-alikes stay.
    expect(keptBy(filter, micSilentLine)).toBe(true);
    expect(keptBy(filter, idleMicSilentLine)).toBe(true);
    expect(keptBy(filter, webVitalLine)).toBe(true);
    expect(keptBy(filter, logLine)).toBe(true);
    expect(keptBy(filter, audioLevelLine('twilio_audio_level_v2'))).toBe(true);
    expect(keptBy(filter, `${logLine} context_type=twilio_audio_level`)).toBe(true);
  });
});
