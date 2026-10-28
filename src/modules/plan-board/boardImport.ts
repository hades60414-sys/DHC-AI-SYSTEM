/** DHC CLI 10/14 規劃白板 匯入: pure parsing of Excalidraw scene files and Mermaid text (no canvas needed). */

export const MAX_IMPORT_ELEMENTS = 2000;

export type ParsedScene = { elements: unknown[] } | { error: string };

/** An Excalidraw scene file ({type:"excalidraw", elements}): deleted elements dropped. */
export function parseExcalidrawJson(text: string): ParsedScene {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { error: '不是有效的 JSON' };
  }
  const raw = (value ?? {}) as { type?: unknown; elements?: unknown };
  if (raw.type !== 'excalidraw' || !Array.isArray(raw.elements)) return { error: '不是 Excalidraw 的白板檔（缺少 type: "excalidraw" 或 elements）' };
  const elements = raw.elements.filter((element) => (
    element && typeof element === 'object' && typeof (element as { id?: unknown }).id === 'string' && typeof (element as { type?: unknown }).type === 'string'
    && !(element as { isDeleted?: unknown }).isDeleted
  ));
  if (elements.length === 0) return { error: '白板檔裡沒有圖形' };
  if (elements.length > MAX_IMPORT_ELEMENTS) return { error: `圖形超過 ${MAX_IMPORT_ELEMENTS} 個，太大沒有匯入` };
  return { elements };
}

const DIAGRAM_START = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|journey|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4\w*)\b/;

/** Strips a leading --- front matter --- block and %% comment lines. */
const body = (text: string) => text.replace(/^\s*---[\s\S]*?\n---\s*\n/, '').split(/\r?\n/).filter((line) => !/^\s*%%/.test(line)).join('\n').trim();

export const looksLikeMermaid = (text: string) => DIAGRAM_START.test(body(text));

/** The Mermaid source in a file: the first ```mermaid block of a markdown file, else the whole text when it starts like a diagram. */
export function extractMermaid(text: string): string | null {
  const fenced = /```[ \t]*mermaid[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(text);
  if (fenced) return fenced[1].trim() || null;
  return looksLikeMermaid(text) ? text.trim() : null;
}

export type ImportKind = 'excalidraw' | 'mermaid' | 'unsupported';

/** .excalidraw/.json -> scene file; .mmd/.mermaid/.md/.txt -> Mermaid. */
export function importKind(fileName: string): ImportKind {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (extension === 'excalidraw' || extension === 'json') return 'excalidraw';
  if (['mmd', 'mermaid', 'md', 'txt'].includes(extension)) return 'mermaid';
  return 'unsupported';
}

export const boardNameFromFile = (fileName: string) => fileName.replace(/\.[^.]*$/, '').trim().slice(0, 60) || '匯入的白板';
