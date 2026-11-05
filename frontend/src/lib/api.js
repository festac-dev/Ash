export async function api(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-Ash-Client": "web" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function requestId() {
  // getRandomValues also works on explicitly allowed private-network HTTP hosts.
  return `web_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// No credentials travel in URLs or browser history.
export function bootstrapSession() {
  return api("/api/auth/session");
}
