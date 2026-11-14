import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function newRequestId(): string {
  return randomUUID();
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function taskId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "T");
  return `task_${stamp}_${randomBytes(3).toString("hex")}`;
}
