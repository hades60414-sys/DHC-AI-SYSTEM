import { describe, expect, it } from 'vitest';

import { brandText, installBrandText } from './brandText';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('brandText', () => {
  it('shows Claude and Claude Code as New coworker, but keeps paths', () => {
    expect(brandText('Claude 正在思考')).toBe('New coworker 正在思考');
    expect(brandText('Ask Claude Code anything')).toBe('Ask New coworker anything');
    expect(brandText('C:\\Users\\demo\\DHC Workspace\\同事B')).toBe('C:\\Users\\demo\\DHC Workspace\\同事B');
    expect(brandText('/home/x/Claude/notes')).toBe('/home/x/Claude/notes');
    expect(brandText('claude --resume')).toBe('claude --resume');
  });
});

describe('installBrandText', () => {
  it('rewrites shown text and labels, now and as the page changes, and leaves code and typing alone', async () => {
    document.body.innerHTML = `
      <div id="a">Claude 回覆</div>
      <button id="b" title="Stop Claude" aria-label="Stop Claude">x</button>
      <pre id="c">claude.exe Claude</pre>
      <textarea id="d">Claude</textarea>
      <input id="e" placeholder="Ask Claude" />`;
    installBrandText();
    expect(document.getElementById('a')!.textContent).toBe('New coworker 回覆');
    expect(document.getElementById('b')!.getAttribute('title')).toBe('Stop New coworker');
    expect(document.getElementById('b')!.getAttribute('aria-label')).toBe('Stop New coworker');
    expect(document.getElementById('c')!.textContent).toBe('claude.exe Claude');
    expect((document.getElementById('d') as HTMLTextAreaElement).value).toBe('Claude');
    expect(document.getElementById('e')!.getAttribute('placeholder')).toBe('Ask New coworker');

    const added = document.createElement('p');
    added.textContent = 'Claude Code 完成了';
    document.body.appendChild(added);
    document.getElementById('a')!.firstChild!.nodeValue = 'Claude 又回覆';
    await tick();
    expect(added.textContent).toBe('New coworker 完成了');
    expect(document.getElementById('a')!.textContent).toBe('New coworker 又回覆');
  });
});
