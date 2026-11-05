import path from "node:path";
import { AshError } from "../errors.js";
import type { ApprovalKind, ApprovalRecord, ApprovalRequest } from "../domain/types.js";
import { ApprovalRecordSchema } from "../domain/schemas.js";
import { atomicWriteJson, ensurePrivateDir, readJsonIfExists, withFileLock } from "../util/fs.js";
import { newId, newNonce } from "../util/ids.js";
import { nowIso, isExpired, addMinutes } from "../util/time.js";
import { parseAmount, formatMinor, type Currency } from "../util/money.js";
import { logger } from "../logger.js";

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  summary: string;
  amount: string | null;
  currency: Currency;
  scope?: Record<string, string>;
  ttlMinutes?: number;
}

/**
 * Human approvals are explicit, expiring, single-use records. Nothing in Ash
 * can create an approved record except the interactive `approve` command,
 * which demands a typed confirmation phrase. Silence never approves.
 */
export class ApprovalManager {
  private readonly file: string;
  private readonly lock: string;
  private readonly taskId: string;
  private readonly defaultTtlMinutes: number;
  private readonly now: () => number;

  constructor(options: { taskId: string; file: string; defaultTtlMinutes: number; now?: () => number }) {
    this.taskId = options.taskId;
    this.file = options.file;
    this.lock = `${options.file}.lock`;
    this.defaultTtlMinutes = options.defaultTtlMinutes;
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<ApprovalRequest[]> {
    return withFileLock(this.lock, async () => {
      const record = await this.load();
      let changed = false;
      for (const request of record.requests) {
        if (
          (request.status === "pending" || request.status === "approved") &&
          isExpired(request.expires_at, this.now())
        ) {
          request.status = "expired";
          changed = true;
        }
      }
      if (changed) await atomicWriteJson(this.file, record);
      return record.requests;
    });
  }

  async pending(): Promise<ApprovalRequest[]> {
    const requests = await this.list();
    return requests.filter((request) => request.status === "pending" && !isExpired(request.expires_at, this.now()));
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return (await this.list()).find((request) => request.id === id) ?? null;
  }

  async request(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const amount = input.amount;
    if (amount !== null) parseAmount(amount, input.currency);
    const at = new Date(this.now()).toISOString();
    const ttl = input.ttlMinutes ?? this.defaultTtlMinutes;
    const request: ApprovalRequest = {
      id: `apr_${newId("a").split("_").slice(-1)[0]}`,
      task_id: this.taskId,
      kind: input.kind,
      summary: input.summary.trim().slice(0, 2_000),
      amount,
      currency: input.currency,
      scope: input.scope ?? {},
      nonce: newNonce(),
      created_at: at,
      expires_at: addMinutes(at, ttl),
      status: "pending",
      decided_at: null,
      decided_by: null,
      reference: null,
      note: null,
    };
    await this.update((record) => {
      if (record.requests.some((existing) => existing.id === request.id)) {
        throw new AshError("CONFLICT", "Approval id collision; retry.");
      }
      record.requests.push(request);
    });
    await logger.audit("approval.requested", {
      task_id: this.taskId,
      approval_id: request.id,
      kind: request.kind,
      amount: request.amount,
      currency: request.currency,
      scope: request.scope,
    });
    return request;
  }

  confirmationPhrase(request: Pick<ApprovalRequest, "id">): string {
    return `APPROVE ${request.id}`;
  }

  denialPhrase(request: Pick<ApprovalRequest, "id">): string {
    return `DENY ${request.id}`;
  }

  /**
   * Record a human decision. The caller (CLI) must collect the exact phrase.
   * This method is deliberately not usable by the execution engine.
   */
  async decide(
    id: string,
    decision: "approved" | "denied",
    confirmation: string,
    note: string | null = null,
  ): Promise<ApprovalRequest> {
    let decided: ApprovalRequest | null = null;
    let expired = false;
    await this.update((record) => {
      const request = record.requests.find((candidate) => candidate.id === id);
      if (!request) throw new AshError("NOT_FOUND", `Approval request ${id} does not exist.`);
      if (request.status !== "pending") {
        throw new AshError("APPROVAL_INVALID", `Approval ${id} is already ${request.status}.`);
      }
      if (isExpired(request.expires_at, this.now())) {
        request.status = "expired";
        expired = true;
        return;
      }
      const expected = decision === "approved" ? this.confirmationPhrase(request) : this.denialPhrase(request);
      if (confirmation.trim() !== expected) {
        throw new AshError("APPROVAL_INVALID", "The confirmation phrase did not match. Nothing was approved.");
      }
      request.status = decision;
      request.decided_at = new Date(this.now()).toISOString();
      request.decided_by = "human";
      request.reference = `human:${request.id}:${request.nonce.slice(0, 8)}`;
      request.note = note?.slice(0, 1_000) ?? null;
      decided = { ...request };
    });
    if (expired) {
      throw new AshError("APPROVAL_INVALID", `Approval ${id} has expired. Request a fresh decision.`);
    }
    if (!decided) throw new AshError("STATE_INVALID", "Approval decision was not recorded.");
    await logger.audit("approval.decided", {
      task_id: this.taskId,
      approval_id: id,
      decision,
      kind: (decided as ApprovalRequest).kind,
      amount: (decided as ApprovalRequest).amount,
      currency: (decided as ApprovalRequest).currency,
    });
    return decided;
  }

  /**
   * Verify that a specific approval is valid for a specific operation.
   * Expired requests are marked expired as a side effect.
   */
  async assertApproved(
    id: string | null,
    kind: ApprovalKind,
    expectedScope: Record<string, string> = {},
  ): Promise<ApprovalRequest> {
    if (!id) {
      throw new AshError("APPROVAL_REQUIRED", `This ${kind} operation requires explicit human approval.`, {
        hint: "Run the related command and approve the request in the Ash prompt.",
      });
    }
    const request = await this.get(id);
    if (!request) throw new AshError("APPROVAL_REQUIRED", `Approval ${id} was not found.`);
    if (request.kind !== kind) {
      throw new AshError("APPROVAL_INVALID", `Approval ${id} is for ${request.kind}, not ${kind}.`);
    }
    if ((request.status === "pending" || request.status === "approved") && isExpired(request.expires_at, this.now())) {
      await this.update((record) => {
        const candidate = record.requests.find((item) => item.id === id);
        if (candidate && (candidate.status === "pending" || candidate.status === "approved"))
          candidate.status = "expired";
      });
      throw new AshError("APPROVAL_REQUIRED", `Approval ${id} expired before the operation ran.`);
    }
    if (request.status !== "approved") {
      throw new AshError("APPROVAL_REQUIRED", `Approval ${id} is ${request.status}, not approved.`);
    }
    for (const [key, value] of Object.entries(expectedScope)) {
      if (request.scope[key] !== value) {
        throw new AshError(
          "APPROVAL_INVALID",
          `Approval ${id} does not cover this operation (${key} changed since approval).`,
        );
      }
    }
    return request;
  }

  private async load(): Promise<ApprovalRecord> {
    const raw = await readJsonIfExists<unknown>(this.file);
    if (raw === null) {
      return { schema_version: 1, task_id: this.taskId, requests: [] };
    }
    try {
      const record = ApprovalRecordSchema.parse(raw) as ApprovalRecord;
      if (record.task_id !== this.taskId) {
        throw new AshError("STATE_INVALID", "Approval file belongs to another task.");
      }
      if (
        record.requests.some((request) => request.task_id !== this.taskId) ||
        new Set(record.requests.map((request) => request.id)).size !== record.requests.length
      ) {
        throw new AshError("STATE_INVALID", "Approval entries contain another task or duplicate identifiers.");
      }
      return record;
    } catch (error) {
      if (error instanceof AshError) throw error;
      throw new AshError("STATE_INVALID", "Approval file is corrupt or unsupported.", { cause: error });
    }
  }

  private async update(mutator: (record: ApprovalRecord) => void): Promise<void> {
    await ensurePrivateDir(path.dirname(this.file));
    await withFileLock(this.lock, async () => {
      const record = await this.load();
      mutator(record);
      // Re-validate the whole record so no code path can write bad approvals.
      ApprovalRecordSchema.parse(record);
      await atomicWriteJson(this.file, record);
    });
  }
}
