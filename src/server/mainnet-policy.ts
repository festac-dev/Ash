import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ID_SCHEMA } from "../domain/schemas.js";
import { AshError } from "../errors.js";
import { TransferProofSchema } from "../providers/mainnet.js";
import { ApprovalManager } from "../security/approvals.js";
import { TaskStore } from "../state/store.js";
import { ensurePrivateDir, atomicWriteJson } from "../util/fs.js";
import { hashJson } from "../util/json.js";
import { PaymentVerificationSchema } from "./mainnet-service.js";
import type { ApprovalRequest } from "../domain/types.js";

export function mainnetApprovalView(approval: ApprovalRequest) {
  const { currency: _currency, amount: _amount, ...view } = approval;
  return { ...view, asset: "NEAR" as const };
}

export const NearAllowanceSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,24})?$/)
  .refine((value) => /[1-9]/.test(value));
export const TransferRequestSchema = z
  .object({
    reference: z
      .string()
      .min(1)
      .max(140)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    kind: z.enum(["native", "wrapped-near"]),
    recipient_account: TransferProofSchema.shape.recipient_account,
    amount_atomic: TransferProofSchema.shape.amount_atomic,
    purpose: PaymentVerificationSchema.shape.purpose.default("revenue-share"),
  })
  .strict();
export const AuthorizedTransferSchema = TransferRequestSchema.extend({
  max_gas_near: NearAllowanceSchema.optional(),
  funding_source: z.enum(["operator", "earnings"]).default("operator"),
  task_id: ID_SCHEMA.optional(),
  task_limit_near: NearAllowanceSchema.optional(),
  approval_id: ID_SCHEMA.optional(),
}).strict();
export type AuthorizedTransfer = z.infer<typeof AuthorizedTransferSchema>;

export function transferTerms(request: AuthorizedTransfer) {
  const { approval_id: _approval, ...terms } = request;
  return terms;
}

/** Exact, expiring transfer authority. The spending record consumes an approval under its own lock. */
export class MainnetPolicy {
  constructor(private readonly config: AppConfig) {}
  private get marker() {
    return path.join(this.config.dataDir, "mainnet", "signing-disabled.json");
  }
  approvals() {
    return new ApprovalManager({
      taskId: `mainnet_${hashJson(this.config.near.account).slice(0, 24)}`,
      file: path.join(this.config.dataDir, "mainnet", "approvals.json"),
      defaultTtlMinutes: this.config.policy.approvalTtlMinutes,
    });
  }
  async enabledStatus(): Promise<boolean> {
    try {
      await this.assertEnabled();
      return true;
    } catch {
      return false;
    }
  }
  async assertEnabled() {
    if (!this.config.near.signingEnabled)
      throw new AshError("UNSAFE_OPERATION", "Signing is disabled. Enable ASH_NEAR_SIGNING_ENABLED explicitly.");
    try {
      await fs.lstat(this.marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new AshError("UNSAFE_OPERATION", "Cannot read the signing stop flag; signing is blocked.");
    }
    throw new AshError(
      "UNSAFE_OPERATION",
      "Signing is disabled by the operator stop flag. Use mainnet enable after review.",
    );
  }
  async setEnabled(enabled: boolean) {
    if (enabled) await fs.rm(this.marker, { force: true });
    else {
      await ensurePrivateDir(path.dirname(this.marker));
      await atomicWriteJson(this.marker, { disabled_at: new Date().toISOString() });
    }
    return { signing_stop_flag: !enabled, configuration_enabled: this.config.near.signingEnabled };
  }
  async assertTask(request: AuthorizedTransfer) {
    if (!request.task_id) return;
    if (!request.task_limit_near)
      throw new AshError("APPROVAL_REQUIRED", "A task-linked transfer requires an explicit task_limit_near allowance.");
    const store = new TaskStore(this.config);
    const task = await store.load(request.task_id);
    if (!["planned", "executing"].includes(task.status))
      throw new AshError("UNSAFE_OPERATION", "Task is stopped or not ready for a payment.");
    if (!task.plan) throw new AshError("APPROVAL_REQUIRED", "Task has no reviewed plan.");
    const approval = await store
      .approvals(task.id)
      .assertApproved(task.plan_approval_ref, "plan", { plan_hash: hashJson(task.plan), currency: task.currency });
    if (approval.currency !== task.currency) throw new AshError("APPROVAL_INVALID", "Task approval currency changed.");
  }
  scope(request: AuthorizedTransfer) {
    return {
      signer_account: this.config.near.account ?? "",
      transfer_sha256: hashJson(transferTerms(request)),
      max_gas_near: request.max_gas_near ?? "",
    };
  }
  async request(input: unknown) {
    const request = AuthorizedTransferSchema.parse(input);
    if (!request.max_gas_near)
      throw new AshError(
        "APPROVAL_REQUIRED",
        "Provide max_gas_near to approve an exact transfer and its gas allowance.",
      );
    if (request.approval_id)
      throw new AshError("VALIDATION_FAILED", "Do not include approval_id when requesting a new approval.");
    await this.assertTask(request);
    const approval = await this.approvals().request({
      kind: "mainnet_transfer",
      amount: null,
      currency: "USD",
      summary: `NEAR mainnet: ${request.amount_atomic} atomic ${request.kind} to ${request.recipient_account}; gas allowance ${request.max_gas_near} NEAR; funding ${request.funding_source}. Reference ${request.reference}.`,
      scope: this.scope(request),
    });
    return {
      approval: mainnetApprovalView(approval),
      transfer: transferTerms(request),
      confirmation_phrase: this.approvals().confirmationPhrase(approval),
      signed: false,
    };
  }
  async assertApproved(request: AuthorizedTransfer) {
    if (!request.max_gas_near)
      throw new AshError("APPROVAL_REQUIRED", "An approved max_gas_near allowance is required for new signing.");
    const approval = await this.approvals().assertApproved(
      request.approval_id ?? null,
      "mainnet_transfer",
      this.scope(request),
    );
    await this.assertTask(request);
    return approval;
  }
}
