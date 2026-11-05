import { describe, expect, it } from 'vitest';

import { formatBotAvatar, parseBotAvatar } from '@/shared/botAvatar';
import { botFace, botSpeaker } from '@/shared/chatRoom';

describe('11/04 AI 辦公室', () => {
  it('reads and writes the three avatar forms, the old single character staying green', () => {
    expect(parseBotAvatar('補')).toEqual({ kind: 'char', char: '補', color: 'green' });
    expect(parseBotAvatar('補 sky')).toEqual({ kind: 'char', char: '補', color: 'sky' });
    expect(parseBotAvatar('animal:geo-fox')).toEqual({ kind: 'animal', id: 'geo-fox' });
    expect(parseBotAvatar('', '小')).toEqual({ kind: 'char', char: '小', color: 'green' });
    expect(formatBotAvatar({ kind: 'char', char: '補', color: 'green' })).toBe('補');
    expect(formatBotAvatar({ kind: 'char', char: '補', color: 'rose' })).toBe('補 rose');
    expect(formatBotAvatar(parseBotAvatar('animal:line-cat'))).toBe('animal:line-cat');
  });

  it('names the helper that answered only when the 【name】 is one of the bots', () => {
    const faces = { 小修小補: 'animal:geo-fox' };
    expect(botSpeaker('【小修小補】記下來了', faces)).toBe('小修小補');
    expect(botFace('【小修小補】記下來了', faces)).toBe('animal:geo-fox');
    expect(botSpeaker('【巡查】今天沒事', faces)).toBeNull();
    expect(botSpeaker('【constructor】x', faces)).toBeNull();
    expect(botSpeaker('普通回覆', faces)).toBeNull();
  });
});
