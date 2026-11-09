import type {
  ApiError,
  ChatItem,
  CreateSessionBody,
  Developer,
  DeveloperBody,
  Project,
  ProjectBody,
  PromptBody,
  Session,
} from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

export const api = {
  items: (sessionId: string) => request<ChatItem[]>(`/api/sessions/${encodeURIComponent(sessionId)}/items`),
  join: (body: DeveloperBody) => post<Developer>('/api/developers', body),
  setProject: (body: ProjectBody) => post<Project>('/api/project', body),
  createSession: (body: CreateSessionBody) => post<Session>('/api/sessions', body),
  prompt: (sessionId: string, body: PromptBody) => post<void>(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, body),
  interrupt: (sessionId: string, developerId: string) =>
    post<void>(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {developerId}),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
