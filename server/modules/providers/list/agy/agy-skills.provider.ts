import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/** Google agy has no SKILL.md convention this tab reads, so no skill roots are exposed. */
export class AgySkillsProvider extends SkillsProvider {
  constructor() {
    super('agy');
  }

  protected async getSkillSources(): Promise<ProviderSkillSource[]> {
    return [];
  }
}
