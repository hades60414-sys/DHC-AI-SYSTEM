import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

const MODELS = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
];
const EFFORTS = [{ value: 'low', description: 'Fastest, cheapest' }, { value: 'xhigh' }] as never;

test('the model list is open at once, ahead of the effort levels, in Chinese', () => {
  const onSelectModel = vi.fn();
  render(
    <ComposerModelMenu effort="low" effortOptions={EFFORTS} onSelectEffort={() => undefined} model="opus"
      modelOptions={MODELS} onSelectModel={onSelectModel} modelsLoading={false} />,
  );
  fireEvent.click(screen.getByRole('button'));
  const menu = screen.getByRole('menu');
  assert.ok(menu.textContent!.indexOf('模型') < menu.textContent!.indexOf('思考強度'));
  assert.ok(screen.getByText('Sonnet'), 'no extra click to reach the models');
  assert.ok(screen.getByText('超高'));
  assert.equal(menu.textContent!.includes('Fastest'), false, 'no English server description');
  fireEvent.click(screen.getByText('Sonnet'));
  assert.deepEqual(onSelectModel.mock.calls, [['sonnet']]);
});
