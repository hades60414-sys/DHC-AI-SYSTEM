import {
  expireAuthSession,
  getStoredAuthToken,
  storeAuthToken,
} from '@/shared/authToken';
import { IS_PLATFORM } from '@/shared/utils';
import type { OfficeDocumentRow, OfficeExtraction, OfficeIdentity, OfficeReconciliation, OfficeSearchHit, OfficeSession } from '@/shared/types';
import { readVoiceConfig, voiceConfigHeaders } from '@/shared/voiceConfig';

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      storeAuthToken(refreshedToken);
    }
    if (response.headers.get('X-Auth-Error')) {
      expireAuthSession();
    }
    return response;
  });
};

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}
const get = (url: string, options: ApiRequestOptions = {}) => authenticatedFetch(url, options);

const withBody =
  (method: string) =>
    (url: string, body?: unknown, options: ApiRequestOptions = {}) =>
      authenticatedFetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });

const post = withBody('POST');
const put = withBody('PUT');
const patch = withBody('PATCH');
const del = withBody('DELETE');

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session. Omitting `limit` requests the whole
 * transcript; passing one always pairs it with an explicit offset so automatic
 * refreshes can never accidentally become an unbounded transcript request.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0 }: { limit?: number | null; offset?: number } = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Every `/api/...` path the frontend talks to is declared here; components
// import a named method instead of assembling URLs of their own.

export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username: string, password: string) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username: string, password: string) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => post('/api/auth/refresh'),
    user: () => get('/api/auth/user'),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => get('/api/projects'),
  archivedProjects: () => get('/api/projects/archived'),
  projectSessions: (
    projectId: string,
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
    options: ApiRequestOptions = {},
  ) =>
    get(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query({ limit, offset })}`,
      options,
    ),
  projectTaskmaster: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  renameProject: (projectId: string, displayName: string) =>
    put(`/api/projects/${projectId}/rename`, { displayName }),
  restoreProject: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/restore`),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId: string, hardDelete = false) =>
    del(`/api/projects/${projectId}${query({ force: hardDelete })}`),
  createProject: (projectData: unknown) => post('/api/projects/create-project', projectData),
  migrateLegacyProjectStars: (projectIds: string[]) =>
    post('/api/projects/migrate-legacy-stars', { projectIds }),
  toggleProjectStar: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`),
  // EventSource cannot send an Authorization header, so the token rides along as
  // a query parameter on the streaming endpoints below.
  cloneProjectProgressUrl: (params: Record<string, QueryValue>) =>
    `/api/projects/clone-progress${query({ ...params, token: getStoredAuthToken() })}`,
  searchConversationsUrl: (searchQuery: string, limit = 50, projectIds: string[] = []) =>
    `/api/providers/search/sessions${query({
      q: searchQuery,
      limit,
      // DHC CLI: only the sidebar's projects; servers before 2026-10-05 ignore it.
      projectIds: projectIds.join(','),
      token: getStoredAuthToken(),
    })}`,

  // Session endpoints. Provider/project metadata are resolved by the backend
  // from the session id.
  // Session deletion mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId: string, hardDelete = false) =>
    del(`/api/providers/sessions/${sessionId}${query({ force: hardDelete })}`),
  getArchivedSessions: () => get('/api/providers/sessions/archived'),
  // Google agy is only allowed in whitelisted projects (it bypasses de-identification).
  agyWorkspaceAccess: (projectPath: string) =>
    get(`/api/providers/agy/workspace-access${query({ projectPath })}`),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () => get('/api/providers/sessions/running'),
  recentConversations: ({ limit = 40, offset = 0 }: { limit?: number; offset?: number } = {}) =>
    get(`/api/providers/sessions/recent${query({ limit, offset })}`),
  providerSessionId: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId: string) => post(`/api/providers/sessions/${sessionId}/restore`),
  // Creates an independent session holding this one's conversation up to
  // `upToAnchorId` (all of it when omitted). The source is left untouched.
  forkSession: (sessionId: string, body: { upToAnchorId?: string; title?: string; projectId?: string } = {}) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/fork`, body),
  renameSession: (sessionId: string, summary: string) =>
    put(`/api/providers/sessions/${sessionId}`, { summary }),
  // DHC CLI 「快速取名」: a short name for what the session is doing now; saves nothing.
  suggestSessionTitle: (sessionId: string) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/suggest-title`, {}),
  // DHC CLI 10/13 規劃白板: the chat beside the canvas; may return a redrawn board. 10/14: runs in the person's
  // project with their memory; the conversation the board was opened from and the selected boxes come along.
  planBoardAssist: (body: { board: unknown; chat: unknown; message: string; projectId?: string | null; sessionId?: string | null; selected?: string[]; linkables?: unknown[]; image?: string }) =>
    post('/api/providers/plan-board/assist', body),
  // DHC CLI 10/14 工具庫: the AI chat beside each tool (專案板、試算工作台…); the tool id picks the instructions.
  toolAssist: (body: { tool: string; context: unknown; chat: unknown; message: string; projectId?: string | null }, signal?: AbortSignal) =>
    post('/api/providers/tool-assist', body, { signal }),

  // Scheduled messages: send a message to a session at a future time.
  scheduledMessages: {
    list: (sessionId?: string) =>
      get(`/api/scheduled-messages${sessionId ? query({ sessionId }) : ''}`),
    create: (body: { sessionId: string; content: string; scheduledFor: string; options?: unknown }) =>
      post('/api/scheduled-messages', body),
    cancel: (id: string) => del(`/api/scheduled-messages/${encodeURIComponent(id)}`),
  },

  // DHC CLI night queue: a session's prompts held for the 02:00 window, or run at once on "run now".
  nightQueue: {
    list: () => get('/api/night-queue/sessions'),
    get: (sessionId: string) => get(`/api/night-queue/sessions/${encodeURIComponent(sessionId)}`),
    setEnabled: (sessionId: string, enabled: boolean, settings?: { startAt: string | null; useBypass: boolean }) =>
      put(`/api/night-queue/sessions/${encodeURIComponent(sessionId)}/mode`, { enabled, ...settings }),
    enqueue: (
      sessionId: string,
      body: {
        content: string;
        options?: unknown;
        mode?: { startAt: string | null; useBypass: boolean };
        /** This prompt's own start time ("@12:05"), over the session's default. */
        startAt?: string | null;
      },
    ) => post(`/api/night-queue/sessions/${encodeURIComponent(sessionId)}/items`, body),
    runNow: (sessionId: string) => post(`/api/night-queue/sessions/${encodeURIComponent(sessionId)}/run-now`),
    cancelAll: (sessionId: string) => post(`/api/night-queue/sessions/${encodeURIComponent(sessionId)}/cancel-all`),
    cancel: (id: string) => del(`/api/night-queue/items/${encodeURIComponent(id)}`),
  },

  // Workspace file tree
  readFile: (projectId: string, filePath: string) =>
    get(`/api/file-tree/projects/${projectId}/file${query({ filePath })}`),
  // Raw bytes for a workspace file. The endpoint requires the auth header, so
  // media call sites fetch a blob through here instead of using a bare `src`.
  readFileBlob: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(fileContentPath(projectId, filePath), options),
  saveFile: (projectId: string, filePath: string, content: string) =>
    put(`/api/file-tree/projects/${projectId}/file`, { filePath, content }),
  getFiles: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/files${query({ respectGitignore: true })}`, options),

  // File operations
  createFile: (
    projectId: string,
    { path, type, name }: { path: string; type: string; name: string },
  ) => post(`/api/file-tree/projects/${projectId}/files/create`, { path, type, name }),

  renameFile: (projectId: string, { oldPath, newName }: { oldPath: string; newName: string }) =>
    put(`/api/file-tree/projects/${projectId}/files/rename`, { oldPath, newName }),

  deleteFile: (projectId: string, { path, type }: { path: string; type: string }) =>
    del(`/api/file-tree/projects/${projectId}/files`, { path, type }),

  // Uploads with a progress bar go through XMLHttpRequest, which needs the URL.
  uploadFilesUrl: (projectId: string) =>
    `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/upload`,

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath: string | null = null) =>
    get(`/api/file-tree/browse-filesystem${query({ path: dirPath })}`),

  createFolder: (folderPath: string) => post('/api/file-tree/create-folder', { path: folderPath }),

  // Git endpoints. The `project` param carries the DB projectId post-migration.
  git: {
    status: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/status${query({ project: projectId })}`, options),
    diff: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/diff${query({ project: projectId, file: filePath })}`, options),
    commitDiff: (projectId: string, commit: string) =>
      get(`/api/git/commit-diff${query({ project: projectId, commit })}`),
    fileWithDiff: (projectId: string, filePath: string) =>
      get(`/api/git/file-with-diff${query({ project: projectId, file: filePath })}`),
    branches: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branches${query({ project: projectId })}`, options),
    remoteStatus: (projectId: string) =>
      get(`/api/git/remote-status${query({ project: projectId })}`),
    commits: (
      projectId: string,
      { limit }: { limit?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(`/api/git/commits${query({ project: projectId, limit })}`, options),
    checkout: (projectId: string, branch: string) =>
      post('/api/git/checkout', { project: projectId, branch }),
    createBranch: (projectId: string, branch: string) =>
      post('/api/git/create-branch', { project: projectId, branch }),
    deleteBranch: (projectId: string, branch: string, force = false) =>
      post('/api/git/delete-branch', { project: projectId, branch, force }),
    fetch: (projectId: string) => post('/api/git/fetch', { project: projectId }),
    pull: (projectId: string) => post('/api/git/pull', { project: projectId }),
    push: (projectId: string) => post('/api/git/push', { project: projectId }),
    publish: (projectId: string, branch: string) =>
      post('/api/git/publish', { project: projectId, branch }),
    discard: (projectId: string, file: string) =>
      post('/api/git/discard', { project: projectId, file }),
    deleteUntracked: (projectId: string, file: string) =>
      post('/api/git/delete-untracked', { project: projectId, file }),
    stage: (projectId: string, files: string[]) =>
      post('/api/git/stage', { project: projectId, files }),
    unstage: (projectId: string, files: string[]) =>
      post('/api/git/unstage', { project: projectId, files }),
    commit: (projectId: string, message: string, files: string[]) =>
      post('/api/git/commit', { project: projectId, message, files }),
    initialCommit: (projectId: string) => post('/api/git/initial-commit', { project: projectId }),
    init: (projectId: string) => post('/api/git/init', { project: projectId }),
    revertLocalCommit: (projectId: string) =>
      post('/api/git/revert-local-commit', { project: projectId }),
    generateCommitMessage: (projectId: string, files: string[], provider: string) =>
      post('/api/git/generate-commit-message', { project: projectId, files, provider }),
  },

  worktrees: {
    list: (projectId: string) => get(`/api/worktrees${query({ project: projectId })}`),
    create: (
      projectId: string,
      { branch, baseBranch }: { branch: string; baseBranch: string | null },
    ) => post('/api/worktrees/create', { project: projectId, branch, baseBranch }),
    open: (projectId: string, worktreePath: string) =>
      post('/api/worktrees/open', { project: projectId, worktreePath }),
    merge: (
      projectId: string,
      worktreePath: string,
      options: { squash?: boolean; message?: string; removeAfterMerge?: boolean },
    ) => post('/api/worktrees/merge', { project: projectId, worktreePath, ...options }),
    remove: (
      projectId: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ) => post('/api/worktrees/remove', { project: projectId, worktreePath, ...options }),
  },

  // Provider (coding agent) endpoints — models, capabilities, sessions, MCP, skills.
  providers: {
    capabilities: () => get('/api/providers/capabilities'),
    authStatus: (provider: string) =>
      get(`/api/providers/${encodeURIComponent(provider)}/auth/status`),

    models: (provider: string) => get(`/api/providers/${provider}/models`),
    createModel: (provider: string, input: unknown) =>
      post(`/api/providers/${provider}/models`, input),
    updateModel: (provider: string, recordId: string | number, input: unknown) =>
      patch(`/api/providers/${provider}/models/${recordId}`, input),
    deleteModel: (provider: string, recordId: string | number) =>
      del(`/api/providers/${provider}/models/${recordId}`),

    createSession: (payload: {
      provider: string;
      projectPath: string;
      initialMessage?: unknown;
    }) => post('/api/providers/sessions', payload),
    // DHC CLI 10/24 開對話建議模型: is Sonnet enough for a new chat's first message? Answers 'opus' when off.
    modelAdvice: (body: { text: string; projectPath: string; hasAttachment: boolean }, signal?: AbortSignal) =>
      post('/api/providers/model-advice', body, { signal }),
    // DHC CLI 10/24 長對話交接: is the last reply a natural stopping point; and the handoff itself (about a minute).
    handoffMoment: (body: { lastUser: string; lastAssistant: string }, signal?: AbortSignal) =>
      post('/api/providers/handoff-moment', body, { signal }),
    handoffSession: (sessionId: string, body: { permissionMode?: string; toolsSettings?: unknown; skipPermissions?: boolean }) =>
      post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/handoff`, body),
    sessionMessages: (
      sessionId: string,
      pagination: { limit?: number | null; offset?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(sessionMessagesUrl(sessionId, pagination), options),
    sessionTokenUsage: (sessionId: string) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/token-usage`),
    sessionActiveModel: (provider: string, sessionId: string) =>
      get(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`),
    setSessionActiveModel: (provider: string, sessionId: string, model: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
      }),
    setSessionActiveEffort: (provider: string, sessionId: string, effort: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-effort`, {
        effort,
      }),

    mcpServers: (
      provider: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) => get(`/api/providers/${provider}/mcp/servers${query({ scope, workspacePath })}`),
    saveMcpServer: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/mcp/servers`, payload),
    deleteMcpServer: (
      provider: string,
      serverName: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) =>
      del(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(serverName)}${query({ scope, workspacePath })}`,
      ),
    saveGlobalMcpServer: (payload: unknown) => post('/api/providers/mcp/servers/global', payload),

    skills: (provider: string, { workspacePath }: { workspacePath?: string } = {}) =>
      get(`/api/providers/${encodeURIComponent(provider)}/skills${query({ workspacePath })}`),
    saveSkills: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/skills`, payload),
  },

  // Slash commands
  commands: {
    // `projectPath` stays optional: a workspace without a resolved path omits
    // the field entirely, which is what the server expects.
    list: (projectPath: string | undefined) => post('/api/commands/list', { projectPath }),
    execute: (payload: unknown) => post('/api/commands/execute', payload),
  },

  // Chat attachments, stored globally under ~/.cloudcli/assets
  assets: {
    uploadFiles: (formData: FormData) =>
      authenticatedFetch('/api/assets/files', {
        method: 'POST',
        headers: {}, // Let browser set Content-Type for FormData
        body: formData,
      }),
    // DHC CLI: chunked upload for attachments over 10MB.
    startUpload: (payload: { name: string; size: number; mimeType: string }) =>
      authenticatedFetch('/api/assets/uploads', { method: 'POST', body: JSON.stringify(payload) }),
    uploadChunk: (id: string, index: number, chunk: Blob, sha256: string) =>
      authenticatedFetch(`/api/assets/uploads/${encodeURIComponent(id)}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha256 },
        body: chunk,
      }),
    completeUpload: (id: string) =>
      authenticatedFetch(`/api/assets/uploads/${encodeURIComponent(id)}/complete`, { method: 'POST' }),
    cancelUpload: (id: string) =>
      authenticatedFetch(`/api/assets/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    file: (storedName: string) => get(`/api/assets/files/${encodeURIComponent(storedName)}`),
    image: (filename: string, options: ApiRequestOptions = {}) =>
      get(`/api/assets/images/${encodeURIComponent(filename)}`, options),
  },

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Update a task
    updateTask: (projectId: string, taskId: string | number, updates: unknown) =>
      put(`/api/taskmaster/update-task/${projectId}/${taskId}`, updates),

    tasks: (projectId: string) => get(`/api/taskmaster/tasks/${encodeURIComponent(projectId)}`),
    mcpStatus: () => get('/api/taskmaster/mcp-status'),
    installationStatus: () => get('/api/taskmaster/installation-status'),

    prdFiles: (projectId: string) => get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`),
    prdFile: (projectId: string, fileName: string) =>
      get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`),
    savePrd: (projectId: string, { fileName, content }: { fileName: string; content: string }) =>
      post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, { fileName, content }),
  },

  // User endpoints
  user: {
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status'),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown }) =>
      put('/api/user/drafts', { scope, ...draft }),
    deleteDraft: (scope: string) => del('/api/user/drafts', { scope }),
  },

  // Server-side settings: API keys, stored credentials, notifications, web push
  settings: {
    apiKeys: () => get('/api/settings/api-keys'),
    createApiKey: (keyName: string) => post('/api/settings/api-keys', { keyName }),
    deleteApiKey: (keyId: string) => del(`/api/settings/api-keys/${keyId}`),
    toggleApiKey: (keyId: string, isActive: boolean) =>
      patch(`/api/settings/api-keys/${keyId}/toggle`, { isActive }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      subscribe: (subscription: { endpoint?: string; keys?: unknown }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  voice: {
    health: () => get('/api/voice/health'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
  },

  system: {
    update: () => post('/api/system/update'),
  },
};

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the DHC CLI proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the DHC CLI voice proxy.
 */
export function transcribeVoice(blob: Blob, filename: string, profile?: 'call', durationMs?: number): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body,
    });
  }

  // DHC CLI 語音通話: the server sends call clips to its faster transcriber when it has one.
  if (profile) body.append('profile', profile);
  if (durationMs) body.append('durationMs', String(Math.round(durationMs)));
  body.append('audio', blob, filename);
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the DHC CLI voice proxy.
 */
export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}

// ---------------------------

//----------------- DHC AI OFFICE（企業模式，/api/enterprise/v1）------------
// 與上方原工作台 API 完全分開：不使用 legacy JWT／authenticatedFetch；token 只放 sessionStorage 並以 Authorization header 傳送。

const OFFICE_API_BASE = '/api/enterprise/v1';
const OFFICE_SESSION_KEY = 'dhc-office-session';

const MESSAGES: Record<string, string> = {
  ENTERPRISE_INVALID_CREDENTIALS: '組織代碼、Email 或密碼不正確',
  ENTERPRISE_RATE_LIMITED: '嘗試次數過多，請 15 分鐘後再試',
  ENTERPRISE_AUTH_REQUIRED: '登入已失效，請重新登入',
  ENTERPRISE_FORBIDDEN: '您的角色沒有此操作權限',
  ENTERPRISE_VERSION_CONFLICT: '內容已被更新，請重新整理後再試',
  ENTERPRISE_DOCUMENT_TYPE_NOT_ALLOWED: '不支援此檔案類型（可上傳 PDF、DOCX、XLSX、PNG、JPEG、TXT、MD、CSV）',
  ENTERPRISE_DOCUMENT_TYPE_MISMATCH: '檔案內容與副檔名不符',
  ENTERPRISE_DOCUMENT_TOO_LARGE: '檔案超過大小上限',
  ENTERPRISE_SUBSCRIPTION_INACTIVE: '訂閱未生效或已到期，目前只能查看與匯出',
  ENTERPRISE_SEAT_LIMIT: '已達方案席位上限',
  ENTERPRISE_RUN_LIMIT: '已達本月 AI 工作次數上限',
  ENTERPRISE_STORAGE_LIMIT: '已達方案儲存空間上限',
  ENTERPRISE_SELF_APPROVAL_FORBIDDEN: '不能核准自己送出的草稿',
  ENTERPRISE_DRAFT_LOCKED: '草稿已送審或核准，無法修改',
  ENTERPRISE_DRAFT_NOT_APPROVED: '草稿尚未核准，無法匯出',
  ENTERPRISE_LAST_ADMIN: '不能停用或移除最後一位管理員',
  ENTERPRISE_MEMBER_EXISTS: '此 Email 已是成員',
  ENTERPRISE_WEAK_PASSWORD: '密碼需 12–256 個字元',
  ENTERPRISE_EGRESS_DENIED: '資料分級或目的地不符合外送政策，已攔截',
  ENTERPRISE_EGRESS_REDIRECT_DENIED: '模型服務要求轉址到未核准的位置，已拒絕',
  ENTERPRISE_CITATION_INVALID: '引用無效或來源已變更，請修正引用後再送審／核准／匯出',
  ENTERPRISE_PRINCIPAL_REVOKED: '申請者目前沒有執行權限，不能放行',
  ENTERPRISE_RUN_NOT_QUARANTINED: '此結果已處理過',
  ENTERPRISE_USAGE_ALREADY_RECONCILED: '此筆用量已對帳',
  ENTERPRISE_INVALID_QUERY: '請輸入 1–8 個查詢詞',
};

/** Office API 錯誤：帶後端代碼與 HTTP 狀態；message 已轉成繁體中文提示。 */
export class OfficeApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

/** 讀取目前 Office session；過期即清除。 */
export function readOfficeSession(): OfficeSession | null {
  try {
    const raw = sessionStorage.getItem(OFFICE_SESSION_KEY);
    const session = raw ? (JSON.parse(raw) as OfficeSession) : null;
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(OFFICE_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** 寫入或清除 Office session（登入／登出）。 */
export function writeOfficeSession(session: OfficeSession | null) {
  if (session) sessionStorage.setItem(OFFICE_SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(OFFICE_SESSION_KEY);
}

type OfficeRequestOptions = { method?: string; json?: unknown; body?: Blob | ArrayBuffer; headers?: Record<string, string>; raw?: boolean };

/** 呼叫企業 API；401 清除 session 並發出 `dhc-office-logout` 讓 OfficeApp 回到登入頁。 */
export async function officeRequest<T>(path: string, options: OfficeRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const session = readOfficeSession();
  if (session) headers.authorization = `Bearer ${session.token}`;
  let body: BodyInit | undefined = options.body as BodyInit | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  let response: Response;
  try {
    response = await fetch(`${OFFICE_API_BASE}${path}`, { method: options.method ?? 'GET', headers, body });
  } catch {
    throw new OfficeApiError('OFFLINE', 0, '無法連線到伺服器，請檢查網路後重試');
  }
  if (!response.ok) {
    let code = 'ENTERPRISE_INTERNAL';
    let message = '伺服器發生錯誤';
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = MESSAGES[code] ?? payload.error?.message ?? message;
    } catch {
      // 非 JSON 錯誤保留預設訊息
    }
    if (response.status === 401 && path !== '/auth/login') {
      writeOfficeSession(null);
      window.dispatchEvent(new Event('dhc-office-logout'));
    }
    throw new OfficeApiError(code, response.status, message);
  }
  if (options.raw) return response as unknown as T;
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 以 Blob 下載匯出檔／原始檔，檔名取自 Content-Disposition。 */
export async function officeDownload(path: string, fallbackName: string) {
  const response = await officeRequest<Response>(path, { raw: true });
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return { filename, sha256: response.headers.get('x-dhc-content-sha256') };
}


/** Office 讀取用端點（供 useOfficeQuery 等以路徑為 key 的讀取）；所有 Office 路徑只在這裡定義。 */
export const officeEndpoints = {
  identity: '/identity/me',
  members: '/members',
  documents: (limit = 50) => `/documents?limit=${limit}`,
  document: (documentId: string) => `/documents/${documentId}`,
  documentVersions: (documentId: string) => `/documents/${documentId}/versions`,
  versionContent: (documentId: string, versionNumber: number) => `/documents/${documentId}/versions/${versionNumber}/content`,
  search: (query: string, includeHistory: boolean) => `/documents/search?q=${encodeURIComponent(query)}${includeHistory ? '&history=true' : ''}`,
  citation: (chunkId: string) => `/citations/${chunkId}`,
  providers: '/models/providers',
  usage: '/usage',
  subscription: '/subscription',
  auditEvents: (cursor: string | null, limit = 50) => `/audit-events?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  runs: '/runs',
  quarantine: (runId: string) => `/runs/${runId}/quarantine`,
  drafts: '/drafts',
  draft: (draftId: string) => `/drafts/${draftId}`,
  draftExport: (draftId: string, format: 'docx' | 'markdown') => `/drafts/${draftId}/export?format=${format}`,
  approvals: '/approvals',
  approval: (approvalId: string) => `/approvals/${approvalId}`,
  reconciliations: '/reconciliations',
  reconciliation: (reconciliationId: string) => `/reconciliations/${reconciliationId}`,
  notifications: '/notifications',
} as const;

/** Office 寫入操作（每個端點一個函式）；元件不得自行組 method／path。 */
export const officeApi = {
  login: (input: { organizationSlug: string; email: string; password: string }) => officeRequest<OfficeSession>('/auth/login', { method: 'POST', json: input }),
  logout: () => officeRequest('/auth/logout', { method: 'POST' }),
  identity: () => officeRequest<OfficeIdentity>(officeEndpoints.identity),
  createMember: (input: { email: string; password: string; roles: string[] }) => officeRequest('/members', { method: 'POST', json: input }),
  disableMember: (memberId: string) => officeRequest(`/members/${memberId}/disable`, { method: 'POST' }),
  enableMember: (memberId: string) => officeRequest(`/members/${memberId}/enable`, { method: 'POST' }),
  /** 上傳新文件；mediaType 由呼叫端依副檔名判定（伺服器仍以內容簽章再驗一次）。 */
  uploadDocument: (input: { body: ArrayBuffer; filename: string; mediaType: string; title: string; classification: string }) =>
    officeRequest<{ extraction?: OfficeExtraction; document?: OfficeDocumentRow }>('/documents', {
      method: 'POST', body: input.body,
      headers: { 'content-type': input.mediaType, 'x-dhc-filename': encodeURIComponent(input.filename), 'x-dhc-title': encodeURIComponent(input.title), 'x-dhc-classification': input.classification },
    }),
  /** 上傳新版本；expectedLatestVersion 以 If-Match 做樂觀鎖。 */
  uploadVersion: (documentId: string, input: { body: ArrayBuffer; filename: string; mediaType: string; expectedLatestVersion: number }) =>
    officeRequest<{ extraction?: OfficeExtraction; document?: OfficeDocumentRow }>(officeEndpoints.documentVersions(documentId), {
      method: 'POST', body: input.body,
      headers: { 'content-type': input.mediaType, 'x-dhc-filename': encodeURIComponent(input.filename), 'if-match': `"${input.expectedLatestVersion}"` },
    }),
  search: (query: string, includeHistory: boolean) => officeRequest<{ items: OfficeSearchHit[] }>(officeEndpoints.search(query, includeHistory)),
  verifyCitation: (chunkId: string) => officeRequest<{ verified: boolean }>(officeEndpoints.citation(chunkId)),
  saveProvider: (input: Record<string, unknown>) => officeRequest('/models/providers', { method: 'PUT', json: input }),
  startDraftRun: (input: { title: string; query: string; providerKey: string }) => officeRequest('/runs/draft-generation', {
    method: 'POST', json: input, headers: { 'idempotency-key': `ui-${crypto.randomUUID()}` },
  }),
  cancelRun: (runId: string) => officeRequest(`/runs/${runId}/cancel`, { method: 'POST' }),
  releaseQuarantine: (runId: string) => officeRequest(`/runs/${runId}/quarantine/release`, { method: 'POST' }),
  discardQuarantine: (runId: string) => officeRequest(`/runs/${runId}/quarantine/discard`, { method: 'POST' }),
  reviseDraft: (draftId: string, input: { expectedRevision: number; body: string }) => officeRequest(officeEndpoints.draft(draftId), { method: 'PUT', json: input }),
  /** 送審：帶作者眼前的修訂版號；伺服器版號已變則 409（ASTRA-V3-NEW-001）。 */
  submitDraft: (draftId: string, expectedRevision: number) => officeRequest(`/drafts/${draftId}/submit`, { method: 'POST', json: { expectedRevision } }),
  /** 審批：expectedRevision／expectedSha256 必須是審核者畫面上那一版，否則 409。 */
  decideApproval: (approvalId: string, input: { decision: 'approve' | 'reject'; comment?: string; expectedRevision: number; expectedSha256: string }) =>
    officeRequest(`/approvals/${approvalId}/decision`, { method: 'POST', json: input }),
  exportDraft: (draftId: string, format: 'docx' | 'markdown') => officeDownload(officeEndpoints.draftExport(draftId, format), format === 'docx' ? 'draft.docx' : 'draft.md'),
  downloadVersion: (documentId: string, versionNumber: number, filename: string) => officeDownload(officeEndpoints.versionContent(documentId, versionNumber), filename),
  /** W6-B：以 ACC-MATCH-v1 對兩個文件版本對帳；同輸入重送回原結果（reused）。 */
  createReconciliation: (input: { ledger: { documentId: string; versionNumber: number }; receipts: { documentId: string; versionNumber: number }; periodStart: string; periodEnd: string }) =>
    officeRequest<{ reconciliation: OfficeReconciliation; reused: boolean }>('/reconciliations', { method: 'POST', json: input }),
  markNotificationRead: (notificationId: string) => officeRequest(`/notifications/${notificationId}/read`, { method: 'POST' }),
};
