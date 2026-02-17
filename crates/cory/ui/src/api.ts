import type {
  Bip329Type,
  GraphResponse,
  HistoryResponse,
  LabelFileSummary,
  LimitsResponse,
} from "./types";

interface ApiErrorPayload {
  error?: unknown;
  message?: unknown;
  code?: unknown;
}

export class ApiError extends Error {
  status: number;
  code: string | null;

  constructor(params: { status: number; message: string; code?: string | null }) {
    const { status, message, code = null } = params;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let apiToken = "";
const INVALID_TOKEN_MESSAGE = "Invalid API token (paste from terminal)";

export function setApiToken(token: string): void {
  apiToken = token.trim();
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return INVALID_TOKEN_MESSAGE;
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function isAuthError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 401;
}

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (apiToken) {
    headers.set("X-API-Token", apiToken);
  }

  const resp = await fetch(path, {
    ...opts,
    headers,
  });

  if (!resp.ok) {
    const fallback = resp.statusText || `HTTP ${resp.status}`;
    const payload = (await resp.json().catch(() => null)) as ApiErrorPayload | string | null;
    const message =
      typeof payload === "string"
        ? payload || fallback
        : payload && typeof payload === "object"
          ? typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : fallback
          : fallback;
    const code =
      payload && typeof payload === "object" && typeof payload.code === "string"
        ? payload.code
        : null;
    throw new ApiError({
      status: resp.status,
      message,
      code,
    });
  }

  return resp;
}

export async function fetchGraph(
  txid: string,
  opts?: { signal?: AbortSignal; maxDepth?: number },
): Promise<GraphResponse> {
  const query = new URLSearchParams();
  if (typeof opts?.maxDepth === "number") {
    query.set("max_depth", String(opts.maxDepth));
  }
  const suffix = query.toString();
  const path = `/api/v1/graph/tx/${encodeURIComponent(txid)}${suffix ? `?${suffix}` : ""}`;
  const resp = await apiFetch(path, { signal: opts?.signal });
  return resp.json() as Promise<GraphResponse>;
}

export async function fetchLimits(): Promise<LimitsResponse> {
  const resp = await apiFetch("/api/v1/limits");
  return resp.json() as Promise<LimitsResponse>;
}

export async function fetchHistory(): Promise<HistoryResponse> {
  const resp = await apiFetch("/api/v1/history");
  return resp.json() as Promise<HistoryResponse>;
}

export async function fetchLabelFiles(): Promise<LabelFileSummary[]> {
  const resp = await apiFetch("/api/v1/label");
  return resp.json() as Promise<LabelFileSummary[]>;
}

export async function createLabelFile(name: string): Promise<LabelFileSummary> {
  const resp = await apiFetch("/api/v1/label", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  return resp.json() as Promise<LabelFileSummary>;
}

export async function importLabelFile(name: string, content: string): Promise<LabelFileSummary> {
  const resp = await apiFetch("/api/v1/label", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, content }),
  });
  return resp.json() as Promise<LabelFileSummary>;
}

export async function setLabelInFile(
  fileId: string,
  labelType: Bip329Type,
  ref: string,
  label: string,
): Promise<LabelFileSummary> {
  const resp = await apiFetch(`/api/v1/label/${encodeURIComponent(fileId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: labelType, ref, label }),
  });
  return resp.json() as Promise<LabelFileSummary>;
}

export async function deleteLabelInFile(
  fileId: string,
  labelType: Bip329Type,
  ref: string,
): Promise<LabelFileSummary> {
  const query = new URLSearchParams({
    type: labelType,
    ref,
  });
  const resp = await apiFetch(
    `/api/v1/label/${encodeURIComponent(fileId)}/entry?${query.toString()}`,
    {
      method: "DELETE",
    },
  );
  return resp.json() as Promise<LabelFileSummary>;
}

export async function deleteLabelFile(fileId: string): Promise<void> {
  await apiFetch(`/api/v1/label/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
  });
}

export async function exportLabelFile(fileId: string): Promise<string> {
  const resp = await apiFetch(`/api/v1/label/${encodeURIComponent(fileId)}/export`);
  return resp.text();
}

export async function exportAllBrowserLabelsZip(): Promise<Blob> {
  const resp = await apiFetch("/api/v1/labels.zip");
  return resp.blob();
}
