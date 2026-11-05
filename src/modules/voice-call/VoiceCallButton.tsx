import { Phone } from 'lucide-react';

import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { isCloudSupported } from '@/modules/chat/hooks/voiceMode';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';

type Props = {
  active: boolean;
  /** The local whisper backend answers. */
  whisperReady: boolean;
  onClick: () => void;
};

/** Rendered by chat's ChatComposer next to the mic button. */
export default function VoiceCallButton({ active, whisperReady, onClick }: Props) {
  const { voiceEnabled } = useUiPreferences();
  if (!voiceEnabled || !(whisperReady || isCloudSupported())) return null;
  return (
    <PromptInputButton
      tooltip={{ content: active ? '語音通話進行中' : '語音通話：用說的交代工作' }}
      aria-label="語音通話"
      data-tutorial-tip="語音通話：用說的交代工作，回覆會唸出來，可隨時插話"
      aria-pressed={active}
      onClick={(event: { preventDefault: () => void }) => {
        event.preventDefault();
        onClick();
      }}
      className={active ? 'text-emerald-600 dark:text-emerald-400' : ''}
    >
      <Phone />
    </PromptInputButton>
  );
}
