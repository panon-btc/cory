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

class TokenManager {
  private tokenAcquisitionPromise: Promise<void> | null = null;
  private tokenRefreshPromise: Promise<boolean> | null = null;

  async acquireToken(): Promise<void> {
    if (this.tokenAcquisitionPromise) {
      return this.tokenAcquisitionPromise;
    }
    this.tokenAcquisitionPromise = this.performTokenAcquisition();
    try {
      await this.tokenAcquisitionPromise;
    } finally {
      this.tokenAcquisitionPromise = null;
    }
  }

  async refreshToken(): Promise<boolean> {
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }
    this.tokenRefreshPromise = this.performTokenRefresh();
    try {
      return await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  async recoverAuth(): Promise<void> {
    const refreshed = await this.refreshToken();
    if (!refreshed) {
      await this.acquireToken();
    }
  }

  private async performTokenAcquisition(): Promise<void> {
    const resp = await fetch("/api/v1/auth/token", {
      method: "POST",
      credentials: "include",
    });
    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Failed to acquire authentication token: ${error}`);
    }
  }

  private async performTokenRefresh(): Promise<boolean> {
    const resp = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (resp.status === 401) {
      return false;
    }
    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Failed to refresh authentication token: ${error}`);
    }
    return true;
  }
}

const tokenManager = new TokenManager();

export async function initializeAuth(): Promise<void> {
  await tokenManager.acquireToken();
}

async function apiFetch(
  path: string,
  opts: RequestInit = {},
  allowAuthRecovery = true,
): Promise<Response> {
  const resp = await fetch(path, {
    ...opts,
    credentials: "include",
  });
  if (resp.status === 401 && allowAuthRecovery) {
    await tokenManager.recoverAuth();
    return apiFetch(path, opts, false);
  }
  if (!resp.ok) {
    const err = (await resp
      .json()
      .catch(() => ({ error: resp.statusText }))) as ApiErrorPayload;
    throw new ApiError(resp.status, err.error || resp.statusText);
  }
  return resp;
}

export async function fetchGraph(txid: string): Promise<GraphResponse> {
  const resp = await apiFetch(`/api/v1/graph/tx/${encodeURIComponent(txid)}`);
  return resp.json() as Promise<GraphResponse>;
}

export async function fetchLabelFiles(): Promise<LabelFileSummary[]> {
  const resp = await apiFetch("/api/v1/label");
  return resp.json() as Promise<LabelFileSummary[]>;
}

export async function createLabelFile(
  name: string,
): Promise<LabelFileSummary> {
  const resp = await apiFetch("/api/v1/label", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  return resp.json() as Promise<LabelFileSummary>;
}

export async function importLabelFile(
  name: string,
  content: string,
): Promise<LabelFileSummary> {
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
  const resp = await apiFetch(
    `/api/v1/label/${encodeURIComponent(fileId)}/export`,
  );
  return resp.text();
}
