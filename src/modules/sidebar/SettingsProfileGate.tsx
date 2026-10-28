import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Folder, Trash2, UserRound, X } from 'lucide-react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import {
  chooseSettingsProfile,
  createSettingsProfile,
  deleteSettingsProfile,
  getUserPreferencesVersion,
  hasHydratedUserPreferences,
  listSettingsProfiles,
  needsSettingsProfileChoice,
  readActiveSettingsProfileId,
  subscribeToUserPreferences,
} from '@/shared/userSettings';
import { isQueryProject, isWorkspaceProject } from '@/modules/sidebar/hooks/useSidebarController';
import { isFlashProject } from '@/shared/flashTasks';

/** Dispatched by the sidebar footer to open the picker on demand. */
export const OPEN_SETTINGS_PROFILES_EVENT = 'dhc:open-settings-profiles';

const SHARED_PROFILE_LABEL = '共用設定';

/** Name of this device's profile, for the sidebar footer. */
export function useActiveSettingsProfileName(): string {
  useSyncExternalStore(subscribeToUserPreferences, getUserPreferencesVersion);
  const activeId = readActiveSettingsProfileId();
  if (!activeId) {
    return SHARED_PROFILE_LABEL;
  }
  return listSettingsProfiles().find((profile) => profile.id === activeId)?.name ?? SHARED_PROFILE_LABEL;
}

function switchTo(profileId: string): void {
  chooseSettingsProfile(profileId);
  // Theme, language and providers are read at module load; a reload is the
  // one way to make every reader pick up the new profile.
  window.location.reload();
}

/**
 * DHC CLI: settings profile picker. Everyone shares one account, so each
 * device picks a project; that project's settings profile (created on first
 * use) holds the theme, provider and permissions, and the project is pinned to
 * the top of the sidebar. Shown by the gate on a new device and in Settings → 專案設定.
 * onDone runs when the already-active entry is picked (switching reloads the page).
 */
export function SettingsProfilePicker({ onDone }: { onDone?: () => void }) {
  useSyncExternalStore(subscribeToUserPreferences, getUserPreferencesVersion);
  const [projects, setProjects] = useState<Project[]>([]);
  const [copyCurrent, setCopyCurrent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.projects();
        const data = (await response.json()) as Project[];
        if (!cancelled && Array.isArray(data)) {
          setProjects(
            data
              .filter((project) => isWorkspaceProject(project) && !isQueryProject(project) && !isFlashProject(project))
              .sort((a, b) => (a.displayName || a.projectId).localeCompare(b.displayName || b.projectId)),
          );
        }
      } catch {
        // The shared profile and existing profiles still work without the list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const done = () => onDone?.();
  const activeId = readActiveSettingsProfileId();
  const profiles = listSettingsProfiles();
  // Profiles made before project linking count as the same-named project's.
  const profileForProject = (project: Project) => profiles.find((profile) => profile.projectId === project.projectId)
    ?? profiles.find((profile) => !profile.projectId && profile.name === (project.displayName || project.projectId));
  const shownProfileIds = new Set(projects.map(profileForProject).filter(Boolean).map((profile) => profile!.id));
  const otherProfiles = profiles.filter((profile) => !shownProfileIds.has(profile.id));

  const handleProject = async (project: Project) => {
    const linked = profileForProject(project);
    if (linked) {
      if (linked.id === activeId) {
        done();
      } else {
        switchTo(linked.id);
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createSettingsProfile(project.displayName || project.projectId, copyCurrent, project.projectId);
      switchTo(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  const handleDelete = async (profileId: string, name: string) => {
    if (!window.confirm(`刪除「${name}」的設定檔？專案與對話不受影響；使用它的裝置下次開啟會重新選擇。`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteSettingsProfile(profileId);
      if (profileId === activeId) {
        window.location.reload();
        return;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setBusy(false);
  };

  const renderRow = (options: {
    key: string;
    label: string;
    hint?: string;
    isActive: boolean;
    icon: 'project' | 'profile';
    onSelect: () => void;
    deletableProfile?: { id: string; name: string };
  }) => (
    <div key={options.key} className="group flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={options.onSelect}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${options.isActive
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-border hover:bg-accent/60'}`}
      >
        {options.icon === 'project'
          ? <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          : <UserRound className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{options.label}</span>
        {options.hint && <span className="text-xs text-muted-foreground">{options.hint}</span>}
        {options.isActive && <Check className="h-4 w-4 text-primary" />}
      </button>
      {options.deletableProfile && (
        <button
          type="button"
          disabled={busy}
          title="刪除這個設定檔（專案不受影響）"
          onClick={() => void handleDelete(options.deletableProfile!.id, options.deletableProfile!.name)}
          className="rounded-md p-2 text-muted-foreground opacity-60 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-900/20"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {projects.map((project) => {
          const linked = profileForProject(project);
          const name = project.displayName || project.projectId;
          return renderRow({
            key: project.projectId,
            label: name,
            hint: linked ? undefined : '尚未設定',
            isActive: Boolean(linked && linked.id === activeId),
            icon: 'project',
            onSelect: () => void handleProject(project),
            deletableProfile: linked ? { id: linked.id, name } : undefined,
          });
        })}
        {otherProfiles.map((profile) => renderRow({
          key: profile.id,
          label: profile.name,
          hint: '其他設定檔',
          isActive: profile.id === activeId,
          icon: 'profile',
          onSelect: () => (profile.id === activeId ? done() : switchTo(profile.id)),
          deletableProfile: { id: profile.id, name: profile.name },
        }))}
        {renderRow({
          key: 'shared',
          label: SHARED_PROFILE_LABEL,
          hint: '不綁專案（原本的設定）',
          isActive: activeId === '',
          icon: 'profile',
          onSelect: () => (activeId === '' ? done() : switchTo('')),
        })}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={copyCurrent}
          disabled={busy}
          onChange={(event) => setCopyCurrent(event.target.checked)}
        />
        第一次選某專案時，從目前畫面的設定複製（不勾＝從預設值開始）
      </label>

      {error && <div className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

/** Opens by itself on a new device (must choose) or on OPEN_SETTINGS_PROFILES_EVENT. */
export default function SettingsProfileGate() {
  useSyncExternalStore(subscribeToUserPreferences, getUserPreferencesVersion);
  const [openedManually, setOpenedManually] = useState(false);

  useEffect(() => {
    const open = () => setOpenedManually(true);
    window.addEventListener(OPEN_SETTINGS_PROFILES_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_PROFILES_EVENT, open);
  }, []);

  const mustChoose = hasHydratedUserPreferences() && needsSettingsProfileChoice();
  if (!mustChoose && !openedManually) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-border bg-background p-5 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            {mustChoose ? '這台裝置是哪個專案的？' : '切換專案設定'}
          </h2>
          {!mustChoose && (
            <button
              type="button"
              onClick={() => setOpenedManually(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent"
              title="關閉"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          選你的專案後，這台裝置的主題、語言、模型提供者、權限與介面設定只跟著這個專案走，不會跟別人互相蓋掉；
          這個專案也會固定排在側欄最上面。對話內容照舊大家都看得到。
        </p>

        <SettingsProfilePicker onDone={() => setOpenedManually(false)} />
      </div>
    </div>
  );
}
