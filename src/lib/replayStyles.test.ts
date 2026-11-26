import { REPLAY_STYLE_RULES } from './replayStyles';
import { REPLAY_TEXT_RULES } from './replayText';

describe('REPLAY_STYLE_RULES', () => {
  it('turn scroll anchoring off in the replayed page and draw the replay texts', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);
    REPLAY_STYLE_RULES.forEach((rule, index) => style.sheet!.insertRule(rule, index));

    const anchoring = (style.sheet!.cssRules[0] as CSSStyleRule).style;
    expect(anchoring.getPropertyValue('overflow-anchor')).toBe('none');
    expect(anchoring.getPropertyPriority('overflow-anchor')).toBe('important');
    expect(REPLAY_STYLE_RULES.slice(1)).toEqual(REPLAY_TEXT_RULES);
    style.remove();
  });
});
