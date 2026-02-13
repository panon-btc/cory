import type { GraphResponse } from "./types";

async function apiFetch(
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((err as { error?: string }).error || resp.statusText);
  }
  return resp;
}

export async function fetchGraph(txid: string): Promise<GraphResponse> {
  const resp = await apiFetch(`/api/v1/graph/tx/${encodeURIComponent(txid)}`);
  return resp.json() as Promise<GraphResponse>;
}

export async function setLabel(
  token: string,
  ref: string,
  label: string,
): Promise<void> {
  await apiFetch("/api/v1/labels/set", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Token": token,
    },
    body: JSON.stringify({ type: "tx", ref, label }),
  });
}

export async function importLabels(token: string, body: string): Promise<void> {
  await apiFetch("/api/v1/labels/import", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-API-Token": token,
    },
    body,
  });
}

export async function exportLabels(): Promise<string> {
  const resp = await apiFetch("/api/v1/labels/export");
  return resp.text();
}
