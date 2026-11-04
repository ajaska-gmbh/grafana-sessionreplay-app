import { readFileSync } from 'fs';
import { join } from 'path';
import { Replayer } from '@grafana/rrweb';

/**
 * patches/@grafana+rrweb+2.0.0-grafana.2.patch: rrweb's Replayer wrote the
 * filtered list of a mutation's removals back into the event
 * (`d.removes = d.removes.filter(...)`). A seek applies earlier events again
 * to a page that already lacks their nodes, so their removals were dropped
 * from the events for good, and every later replay of that session in the
 * tab kept those elements (seen: the dialer's categorisation modal staying
 * open after the agent had answered it).
 */
describe('rrweb patch: replaying never changes the events', () => {
  function fakeReplayer() {
    return {
      config: { useVirtualDom: false },
      usingVirtualDom: false,
      mirror: { getNode: () => null, getId: () => -1, has: () => false },
      warnNodeNotFound: jest.fn(),
      warn: jest.fn(),
      legacy_missingNodeRetryMap: {},
    };
  }

  it('keeps a removal whose node is not in the page at the time', () => {
    const removes = [{ parentId: 39, id: 497 }];
    const mutation = { source: 0, texts: [], attributes: [], removes, adds: [] };

    (Replayer.prototype as unknown as { applyMutation: (d: unknown, isSync: boolean) => void }).applyMutation.call(
      fakeReplayer(),
      mutation,
      false
    );

    expect(mutation.removes).toBe(removes);
    expect(mutation.removes).toEqual([{ parentId: 39, id: 497 }]);
  });

  it.each(['rrweb.js', 'rrweb.cjs', 'rrweb.umd.cjs'])('is applied to the %s build', (file) => {
    const source = readFileSync(join(__dirname, '../../node_modules/@grafana/rrweb/dist', file), 'utf8');

    expect(source).toContain('const removes = d.removes.filter(');
    expect(source).not.toContain('d.removes = d.removes.filter(');
  });
});
