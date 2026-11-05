import { readAgyTranscript, agyTranscriptPath } from '@/modules/providers/list/agy/agy-transcript.js';
import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/** Billed against the Google student plan quota; picked by the user as the tab default. */
export const AGY_DEFAULT_MODEL = 'claude-opus-4-6-thinking';

/** Mirrors `agy.exe models` (agy 1.4.10). */
export const AGY_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', description: 'Google agy' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', description: 'Google agy' },
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: 'Google agy' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', description: 'Google agy' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', description: 'Google agy' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', description: 'Google agy' },
  ],
  DEFAULT: AGY_DEFAULT_MODEL,
};

export class AgyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return AGY_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId?.trim()) {
      // The transcript's first line records the model the conversation started with.
      const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;
      const file = agyTranscriptPath(providerSessionId);
      const meta = file ? (await readAgyTranscript(file)).meta : null;
      if (meta?.model) {
        return { model: meta.model };
      }
    }
    return buildDefaultProviderCurrentActiveModel(AGY_PREDEFINED_MODELS);
  }
}
