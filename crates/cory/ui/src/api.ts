import type { Bip329Type, GraphResponse, LabelFileSummary } from "./types";

interface ApiErrorPayload {
  error?: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let apiToken = "";

export function setApiToken(token: string): void {
  apiToken = token.trim();
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
    const err = (await resp.json().catch(() => ({ error: resp.statusText }))) as ApiErrorPayload;
    throw new ApiError(resp.status, err.error || resp.statusText);
  }

  return resp;
}

export async function fetchGraph(txid: string, signal?: AbortSignal): Promise<GraphResponse> {
  const resp = await apiFetch(`/api/v1/graph/tx/${encodeURIComponent(txid)}`, { signal });
  return resp.json() as Promise<GraphResponse>;
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
