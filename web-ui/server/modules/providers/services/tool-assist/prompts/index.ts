import { CODE_REVIEW_PROMPT } from '@/modules/providers/services/tool-assist/prompts/code-review.js';
import { DECK_STUDIO_PROMPT } from '@/modules/providers/services/tool-assist/prompts/deck-studio.js';
import { DOC_EDITOR_PROMPT } from '@/modules/providers/services/tool-assist/prompts/doc-editor.js';
import { PROJECT_BOARD_PROMPT } from '@/modules/providers/services/tool-assist/prompts/project-board.js';
import { SHEET_BENCH_PROMPT } from '@/modules/providers/services/tool-assist/prompts/sheet-bench.js';
import { TOOL_WORKSHOP_PROMPT } from '@/modules/providers/services/tool-assist/prompts/tool-workshop.js';

/**
 * System prompts for the AI beside each 工具庫 tool, keyed by tool id (src/modules/tool-library/catalog.ts).
 * Each says what the tool is, what the context JSON holds, and the exact shape of `result`; the common
 * reply/result rules are added by tool-assist.service.ts. One file per tool.
 */
export const TOOL_PROMPTS: Record<string, string> = {
  'project-board': PROJECT_BOARD_PROMPT,
  'code-review': CODE_REVIEW_PROMPT,
  'sheet-bench': SHEET_BENCH_PROMPT,
  'doc-editor': DOC_EDITOR_PROMPT,
  'tool-workshop': TOOL_WORKSHOP_PROMPT,
  'deck-studio': DECK_STUDIO_PROMPT,
};
