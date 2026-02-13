import type { GraphResponse } from "./types";

// Manages JWT token lifecycle and deduplicates concurrent auth calls.
class TokenManager {
  private tokenAcquisitionPromise: Promise<void> | null = null;
  private tokenRefreshPromise: Promise<boolean> | null = null;

  // Acquire a JWT token by calling the auth endpoint.
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

  // Attempt to refresh the current JWT cookie. Returns false when refresh is
  // not possible (for example, no cookie or expired cookie).
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

  // Recover auth after a 401. Prefer refresh, then fall back to minting a new
  // token if refresh is not possible.
  async recoverAuth(): Promise<void> {
    const refreshed = await this.refreshToken();
    if (!refreshed) {
      await this.acquireToken();
    }
  }

  private async performTokenAcquisition(): Promise<void> {
    console.debug("Acquiring new JWT token...");
    const resp = await fetch("/api/v1/auth/token", {
      method: "POST",
      credentials: "include",
    });

    if (!resp.ok) {
      const error = await resp.text();
      console.error(
        `Token acquisition failed with status ${resp.status}: ${error}`,
      );
      throw new Error(
        `Failed to acquire authentication token: ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as { expires_in: number };
    console.info(`JWT token acquired, expires in ${data.expires_in}s`);
  }

  private async performTokenRefresh(): Promise<boolean> {
    console.debug("Refreshing JWT token...");
    const resp = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });

    if (resp.status === 401) {
      console.info("JWT refresh unavailable; acquiring a new token");
      return false;
    }

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Failed to refresh authentication token: ${error}`);
    }

    const data = (await resp.json()) as { expires_in: number };
    console.info(`JWT token refreshed, expires in ${data.expires_in}s`);
    return true;
  }
}

const tokenManager = new TokenManager();

export async function initializeAuth(): Promise<void> {
  try {
    await tokenManager.acquireToken();
    console.info("Authentication initialized successfully");
  } catch (err) {
    console.error("Failed to initialize authentication:", err);
    throw err;
  }
}

// ==============================================================================
// API Fetch Helper
// ==============================================================================

async function apiFetch(
  path: string,
  opts: RequestInit = {},
  allowAuthRecovery = true,
): Promise<Response> {
  const fetchOpts: RequestInit = {
    ...opts,
    credentials: "include",
    headers: {
      ...(opts.headers instanceof Headers
        ? Object.fromEntries(opts.headers.entries())
        : typeof opts.headers === "object"
          ? opts.headers
          : {}),
    },
  };

  const resp = await fetch(path, fetchOpts);

  if (resp.status === 401 && allowAuthRecovery) {
    await tokenManager.recoverAuth();
    return apiFetch(path, opts, false);
  }

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

export async function setLabel(ref: string, label: string): Promise<void> {
  // Protected route - requires valid JWT cookie from initializeAuth()
  await apiFetch("/api/v1/labels/set", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "tx", ref, label }),
  });
}

export async function importLabels(body: string): Promise<void> {
  // Protected route - requires valid JWT cookie from initializeAuth()
  await apiFetch("/api/v1/labels/import", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
    },
    body,
  });
}

export async function exportLabels(): Promise<string> {
  const resp = await apiFetch("/api/v1/labels/export");
  return resp.text();
}
