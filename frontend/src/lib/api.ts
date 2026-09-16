/**
 * AwaazOnboard API Helper
 *
 * All calls go through the Next.js rewrite proxy (/api/* → localhost:8000/*),
 * so we never need to worry about CORS.
 */

const API_BASE = "/api";

export async function apiFetch<T = unknown>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }

  return res.json();
}
