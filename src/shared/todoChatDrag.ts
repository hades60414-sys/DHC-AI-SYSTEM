/**
 * DHC CLI 10/08: a todo dragged from the dock into the chat. The dock packs what the chat needs into the drag
 * (the chat never reads the todo store): an empty conversation starts a plan-mode turn about the task, an
 * existing one gets a "focus on this" line in the composer.
 */
// Not the matrix's 'application/x-dhc-todo' (which carries a task id): sharing it sent this JSON to the quadrants.
export const TODO_CHAT_DRAG_TYPE = 'application/x-dhc-todo-chat';

export type TodoChatPayload = {
  text: string;
  /** "上層 › 上上層", empty for a main task. */
  trail: string;
  /** Open subtasks, already indented two spaces per level. */
  subtasks: string[];
};

export function hasTodoChatDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(TODO_CHAT_DRAG_TYPE));
}

export function readTodoChatDrag(dataTransfer: DataTransfer | null): TodoChatPayload | null {
  const raw = dataTransfer?.getData(TODO_CHAT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TodoChatPayload>;
    if (typeof value.text !== 'string' || !value.text.trim()) return null;
    return {
      text: value.text.trim(),
      trail: typeof value.trail === 'string' ? value.trail : '',
      subtasks: Array.isArray(value.subtasks) ? value.subtasks.filter((line) => typeof line === 'string') : [],
    };
  } catch {
    return null;
  }
}

const bulletList = (lines: string[]) => lines.map((line) => line.replace(/^(\s*)/, '$1- ')).join('\n');

export function todoPlanPrompt({ text, trail, subtasks }: TodoChatPayload): string {
  return [
    `幫我規劃這個待辦任務：${text}${trail ? `（屬於：${trail}）` : ''}`,
    subtasks.length > 0 && `子任務：\n${bulletList(subtasks)}`,
    '先弄清楚目標和範圍，有需要我決定的地方先問我；再給出可執行的步驟，每一步寫怎麼驗證。',
  ]
    .filter(Boolean)
    // Blank lines so markdown doesn't fold the closing sentence into the last list item.
    .join('\n\n');
}

export function todoFocusText({ text, trail, subtasks }: TodoChatPayload): string {
  return [
    `接下來聚焦這個任務：${text}${trail ? `（屬於：${trail}）` : ''}`,
    subtasks.length > 0 && `子任務：\n${bulletList(subtasks)}`,
  ]
    .filter(Boolean)
    .join('\n');
}
