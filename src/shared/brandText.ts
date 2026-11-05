/**
 * DHC CLI 品牌 (2026-11-02, 使用者)：網頁上所有 "Claude" 顯示成 "New coworker"。The text lives in 39 components and every
 * locale, so it is swapped where it is shown instead of in each source string. Left alone: code blocks, editors, the
 * terminal and anything the user is typing, and a "Claude" inside a path (C:\Users\demo\DHC Workspace) so a copied path or
 * command still works.
 */

const BRAND = 'New coworker';
const CLAUDE_RE = /(?<![\\/])Claude(?: Code)?/g;
const SKIP_SELECTOR = 'code, pre, textarea, input, script, style, [contenteditable], .cm-editor, .xterm, .monaco-editor';
const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

export const brandText = (text: string) => text.replace(CLAUDE_RE, BRAND);

// A box's placeholder and label are page text; only what is typed in it is the user's.
const ATTRIBUTE_SKIP_SELECTOR = 'code, pre, script, style, .cm-editor, .xterm, .monaco-editor';

const skipped = (el: Element | null) => !el || Boolean(el.closest(SKIP_SELECTOR));

function brandAttributes(el: Element): void {
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value && value.includes('Claude') && !el.closest(ATTRIBUTE_SKIP_SELECTOR)) {
      const next = brandText(value);
      if (next !== value) el.setAttribute(name, next);
    }
  }
}

function brandTextNode(node: Node): void {
  const value = node.nodeValue;
  if (!value || !value.includes('Claude') || skipped(node.parentElement)) return;
  const next = brandText(value);
  if (next !== value) node.nodeValue = next;
}

function brandTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return brandTextNode(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  brandAttributes(root as Element);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) brandTextNode(n);
    else brandAttributes(n as Element);
  }
}

let installed = false;

export function installBrandText(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  brandTree(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') brandTextNode(record.target);
      else if (record.type === 'attributes') brandAttributes(record.target as Element);
      else record.addedNodes.forEach(brandTree);
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
}
