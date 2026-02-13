import type { GraphResponse } from "./types";

/// Manages JWT token distribution and validation as well
class TokenManager {
  private tokenAcquisitionPromise: Promise<void> | null = null;

  /// Acquire a JWT token by calling the auth endpoint.
  async acquireToken(): Promise<void> {
    // Prevent concurrent token acquisition attempts
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
}

const tokenManager = new TokenManager();

/// Initialize the API layer by acquiring an initial JWT token.

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

/// Makes authenticated API requests with automatic cookie-based JWT handling.
/// All requests include credentials: 'include' to send cookies, and the server
/// automatically validates JWT tokens from the HttpOnly cookie.
async function apiFetch(
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  // Ensure we include cookies in requests (for JWT authentication)
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

  // If we get 401, the user is not authenticated
  if (resp.status === 401) {
    console.error(`Authentication failed for ${path} - no valid token`);
    throw new Error(
      "Authentication required. Please refresh the page to authenticate.",
    );
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((err as { error?: string }).error || resp.statusText);
  }

  return resp;
}

export async function fetchGraph(txid: string): Promise<GraphResponse> {
  // Graph queries are public, no authentication required
  const resp = await fetch(`/api/v1/graph/tx/${encodeURIComponent(txid)}`, {
    credentials: "include",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((err as { error?: string }).error || resp.statusText);
  }
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
  const resp = await fetch("/api/v1/labels/export", {
    credentials: "include",
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((err as { error?: string }).error || resp.statusText);
  }
  return resp.text();
}
