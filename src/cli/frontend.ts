import type { ServerSession } from "../server/server.js";
import type { FrontendStatus } from "../server/frontend.js";
import { AshError } from "../errors.js";

export interface FrontendResult extends FrontendStatus {
  code?: string | null;
  expires_at?: string | null;
}
export function workspaceUrl(url: string): string {
  return new URL("/workspace", url).href;
}

export async function frontendRequest(
  session: ServerSession,
  action: string,
  signal?: AbortSignal,
): Promise<FrontendResult> {
  const suffix = ["code", "logout-all", "cycle"].includes(action) ? `/${action}` : "";
  const response = await fetch(`${session.url}/api/frontend${suffix}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    ...(action === "status"
      ? {}
      : { body: JSON.stringify({ running: action === "on" ? true : action === "off" ? false : undefined }) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000),
  });
  const result = (await response.json()) as FrontendResult & { error?: { message?: string } };
  if (!response.ok) throw new AshError("CONFLICT", result.error?.message ?? "Frontend command failed.");
  return result;
}

export function frontendText(result: FrontendResult, simulated: boolean, compact = false): string {
  const next = { start: "start frontend", code: "generate access code", stop: "close frontend and revoke access" }[
    result.next_action
  ];
  const lines = [
    `${simulated ? "[DEMO] " : ""}Frontend ${result.running ? "ON" : "OFF"}${result.port ? ` · port ${result.port}` : ""} · B: ${next}`,
  ];
  if (compact) return lines.join("\n") + "\n";
  if (result.running && result.url) lines.push(`Workspace: ${workspaceUrl(result.url)}`);
  if (
    result.running &&
    result.url?.startsWith("http://") &&
    ((!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) || process.env.SSH_CONNECTION)
  )
    lines.push(`From your computer: ssh -L ${result.port}:localhost:${result.port} user@vps`);
  if (result.code) {
    lines.push(`One-time code: ${result.code}`, `Expires: ${result.expires_at}`);
  }
  if (!result.running) lines.push("Access revoked.");
  return lines.join("\n") + "\n";
}
