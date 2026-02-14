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

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

interface TokenResponse {
  access_token: string;
  access_token_expires_in: number;
  refresh_token_expires_in?: number;
  session_id: string;
  message: string;
}

interface RefreshTokenResponse {
  access_token: string;
  access_token_expires_in: number;
  message: string;
}

class TokenManager {
  private tokenAcquisitionPromise: Promise<void> | null = null;
  private tokenRefreshPromise: Promise<boolean> | null = null;
  private authRecoveryPromise: Promise<void> | null = null;
  private readonly ACCESS_TOKEN_KEY = "cory_access_token";

  getAccessToken(): string | null {
    return localStorage.getItem(this.ACCESS_TOKEN_KEY);
  }

  private setAccessToken(token: string): void {
    localStorage.setItem(this.ACCESS_TOKEN_KEY, token);
  }

  clearAccessToken(): void {
    localStorage.removeItem(this.ACCESS_TOKEN_KEY);
  }

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
    if (this.authRecoveryPromise) {
      return this.authRecoveryPromise;
    }
    this.authRecoveryPromise = this.performAuthRecovery();
    try {
      await this.authRecoveryPromise;
    } finally {
      this.authRecoveryPromise = null;
    }
  }

  private async performAuthRecovery(): Promise<void> {
    const refreshed = await this.refreshToken();
    if (!refreshed) {
      throw new SessionExpiredError("Session expired. Please refresh the page to log in again.");
    }
  }

  async ensureAccessToken(): Promise<string> {
    let token = this.getAccessToken();
    if (!token) {
      await this.recoverAuth();
      token = this.getAccessToken();
      if (!token) {
        throw new SessionExpiredError("Session expired. Please refresh the page to log in again.");
      }
    }
    return token;
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
    const data = (await resp.json()) as TokenResponse;
    this.setAccessToken(data.access_token);
  }

  private async performTokenRefresh(): Promise<boolean> {
    const resp = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (resp.status === 401) {
      this.clearAccessToken();
      return false;
    }
    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Failed to refresh authentication token: ${error}`);
    }
    const data = (await resp.json()) as RefreshTokenResponse;
    this.setAccessToken(data.access_token);
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
  const accessToken = await tokenManager.ensureAccessToken();
  const headers = new Headers(opts.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const resp = await fetch(path, {
    ...opts,
    headers,
    credentials: "include",
  });

  if (resp.status === 401 && allowAuthRecovery) {
    await tokenManager.recoverAuth();
    return apiFetch(path, opts, false);
  }

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
