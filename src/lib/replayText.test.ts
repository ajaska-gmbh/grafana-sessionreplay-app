import { REPLAY_TEXT_RULES } from './replayText';

describe('REPLAY_TEXT_RULES', () => {
  it('are valid CSS that draws data-replay-text over its element', () => {
    const style = document.createElement('style');
    document.head.appendChild(style);
    REPLAY_TEXT_RULES.forEach((rule, index) => style.sheet!.insertRule(rule, index));

    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    expect(rules).toHaveLength(REPLAY_TEXT_RULES.length);
    const text = rules.find((rule) => rule.selectorText === '[data-replay-text]::after')!;
    expect(text.style.getPropertyValue('content')).toBe('attr(data-replay-text)');
    expect(text.style.getPropertyValue('pointer-events')).toBe('none');
    style.remove();
  });
});
