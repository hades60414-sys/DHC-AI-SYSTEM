/**
 * DHC CLI 11/04 AI 辦公室: a helper's face, kept on the bot file's `avatar:` line as 「補」 (green, the old form),
 * 「補 sky」 (a character on a colour) or 「animal:geo-fox」 (one of the animal avatars). The server accepts the same
 * three forms (assistant.service.ts `botAvatarOk`).
 */
export const BOT_COLORS = ['green', 'sky', 'violet', 'amber', 'rose', 'slate'] as const;
export type BotColor = (typeof BOT_COLORS)[number];
export const BOT_COLOR_CLASS: Record<BotColor, string> = {
  green: 'from-green-400 to-green-500',
  sky: 'from-sky-400 to-sky-500',
  violet: 'from-violet-400 to-violet-500',
  amber: 'from-amber-400 to-amber-500',
  rose: 'from-rose-400 to-rose-500',
  slate: 'from-slate-500 to-slate-600',
};
export const BOT_COLOR_NAMES: Record<BotColor, string> = { green: '綠', sky: '藍', violet: '紫', amber: '橘', rose: '粉', slate: '灰' };

export type BotAvatar = { kind: 'animal'; id: string } | { kind: 'char'; char: string; color: BotColor };

export function parseBotAvatar(value: string | null | undefined, fallback = '助'): BotAvatar {
  const text = (value ?? '').trim();
  const animal = /^animal:([\w-]{1,40})$/.exec(text);
  if (animal) return { kind: 'animal', id: animal[1] };
  const [char = '', color = ''] = text.split(/\s+/);
  return { kind: 'char', char: Array.from(char)[0] || fallback, color: (BOT_COLORS as readonly string[]).includes(color) ? (color as BotColor) : 'green' };
}

export const formatBotAvatar = (avatar: BotAvatar): string =>
  avatar.kind === 'animal' ? `animal:${avatar.id}` : avatar.color === 'green' ? avatar.char : `${avatar.char} ${avatar.color}`;
