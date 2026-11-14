import { z } from "zod";
import { AshError } from "../errors.js";
import { assertAccount, assertText } from "../journey/core.js";
import { hashJson } from "../util/json.js";

export interface MainnetConfig {
  rpcUrl: string;
  oneClickUrl: string;
  account: string | null;
  timeoutMs: number;
  signingEnabled: boolean;
  signingKeyFile: string | null;
  maxTotalNear: string;
  allowedRecipients: string[];
}

export function loadMainnetConfig(env: NodeJS.ProcessEnv): MainnetConfig {
  const endpoint = (value: string, label: string): string => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AshError("CONFIG_INVALID", `${label} must be an HTTPS URL.`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new AshError("CONFIG_INVALID", `${label} must use HTTPS without credentials, query or fragment.`);
    return url.toString().replace(/\/$/, "");
  };
  const timeout = env.ASH_NEAR_TIMEOUT_MS?.trim() || "20000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 60000)
    throw new AshError("CONFIG_INVALID", "ASH_NEAR_TIMEOUT_MS must be between 1000 and 60000.");
  const maxTotalNear = env.ASH_NEAR_MAX_TOTAL_NEAR?.trim() || "0.01";
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(maxTotalNear) || !/[1-9]/.test(maxTotalNear))
    throw new AshError("CONFIG_INVALID", "ASH_NEAR_MAX_TOTAL_NEAR must be a positive decimal with at most 24 places.");
  const signing = env.ASH_NEAR_SIGNING_ENABLED?.trim() || "false";
  if (!["true", "false", "1", "0"].includes(signing))
    throw new AshError("CONFIG_INVALID", "ASH_NEAR_SIGNING_ENABLED must be true or false.");
  const id = env.ASH_NEAR_ACCOUNT?.trim() ? mainnetAccount(env.ASH_NEAR_ACCOUNT) : null;
  return {
    rpcUrl: endpoint(env.ASH_NEAR_RPC_URL?.trim() || "https://rpc.mainnet.near.org", "ASH_NEAR_RPC_URL"),
    oneClickUrl: endpoint(env.ASH_ONECLICK_URL?.trim() || "https://1click.chaindefuser.com/v0", "ASH_ONECLICK_URL"),
    account: id,
    timeoutMs: Number(timeout),
    signingEnabled: signing === "true" || signing === "1",
    signingKeyFile: env.ASH_NEAR_SIGNING_KEY_FILE?.trim() || null,
    maxTotalNear,
    allowedRecipients: env.ASH_NEAR_ALLOWED_RECIPIENTS?.trim()
      ? env.ASH_NEAR_ALLOWED_RECIPIENTS.split(",").map((value) => mainnetAccount(value.trim()))
      : id
        ? [id]
        : [],
  };
}

export function mainnetAccount(value: string): string {
  const account = assertAccount(value, "Mainnet account");
  if (account === "testnet" || account.endsWith(".testnet"))
    throw new AshError("VALIDATION_FAILED", "A testnet account cannot be used for NEAR mainnet verification.");
  return account;
}

const atomic = z.string().regex(/^[1-9]\d{0,77}$/);
const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .refine((value) => value !== "testnet" && !value.endsWith(".testnet"), "Use a mainnet account.");
const hash = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .refine((value) => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let decoded = 0n;
    for (const char of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
    const leadingZeros = value.length - value.replace(/^1+/, "").length;
    const bytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
    return leadingZeros + bytes === 32;
  }, "Expected a 32-byte base58 hash.");

export const DryQuoteInputSchema = z
  .object({
    origin_asset: z.string().min(1).max(200),
    destination_asset: z.string().min(1).max(200),
    amount_atomic: atomic,
    refund_to: z.string().min(2).max(200),
    recipient: account,
    slippage_bps: z.number().int().min(0).max(100).default(50),
  })
  .strict();
export type DryQuoteInput = z.input<typeof DryQuoteInputSchema>;

export const TransferProofSchema = z
  .object({
    tx_hash: hash,
    signer_account: account,
    sender_account: account,
    recipient_account: account,
    token_account: account,
    amount_atomic: atomic,
  })
  .strict();
export type TransferProof = z.infer<typeof TransferProofSchema>;

const tokenSchema = z.object({
  assetId: z.string(),
  decimals: z.number().int().min(0).max(38),
  blockchain: z.string(),
  symbol: z.string(),
  contractAddress: z.string().optional(),
});
const successStatus = z
  .record(z.string(), z.unknown())
  .refine((status) => "SuccessValue" in status || "SuccessReceiptId" in status, "Execution did not succeed.");
const outcomeSchema = z.object({
  id: z.string(),
  block_hash: hash,
  outcome: z.object({ executor_id: z.string(), logs: z.array(z.string()), status: successStatus }),
});
const transactionSchema = z.object({
  final_execution_status: z.literal("FINAL"),
  status: z.object({ SuccessValue: z.string() }),
  transaction: z.object({
    hash,
    signer_id: account,
    receiver_id: z.string().optional(),
    actions: z.array(z.unknown()).optional(),
  }),
  transaction_outcome: outcomeSchema,
  receipts_outcome: z.array(outcomeSchema).min(1),
});

export class MainnetClient {
  constructor(
    readonly config: MainnetConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(url: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AshError(
          "MARKET_UNAVAILABLE",
          `NEAR provider returned HTTP ${response.status}; no settlement is assumed.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AshError("MARKET_PROTOCOL_ERROR", "NEAR provider returned an empty response.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new AshError("MARKET_PROTOCOL_ERROR", "NEAR provider response exceeds 2 MB.");
        }
        chunks.push(value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new AshError("MARKET_PROTOCOL_ERROR", "NEAR provider response is not valid JSON.");
      }
    } catch (error) {
      if (error instanceof AshError) throw error;
      throw new AshError("MARKET_UNAVAILABLE", "NEAR provider request failed or timed out; no settlement is assumed.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async rpc(
    method: "status" | "query" | "tx" | "gas_price" | "EXPERIMENTAL_protocol_config" | "broadcast_tx_commit",
    params: unknown,
  ): Promise<unknown> {
    const result = z
      .object({ result: z.unknown().optional(), error: z.unknown().optional() })
      .safeParse(await this.request(this.config.rpcUrl, { jsonrpc: "2.0", id: "ash-mainnet", method, params }));
    if (!result.success || result.data.error || result.data.result === undefined)
      throw new AshError("MARKET_PROTOCOL_ERROR", "NEAR RPC rejected the read; no on-chain result is assumed.");
    return result.data.result;
  }

  async status() {
    const result = z
      .object({
        chain_id: z.literal("mainnet"),
        sync_info: z.object({
          syncing: z.literal(false),
          latest_block_height: z.number().int().positive(),
          latest_block_hash: hash,
          latest_block_time: z.string().datetime(),
        }),
      })
      .safeParse(await this.rpc("status", []));
    if (!result.success) throw new AshError("VERIFICATION_FAILED", "RPC is not a synchronized NEAR mainnet node.");
    return {
      network: "mainnet" as const,
      ...result.data.sync_info,
      rpc_url: this.config.rpcUrl,
      checked_at: new Date().toISOString(),
      funds_spent: "0",
      signed: false,
    };
  }

  async signingContext(accountId: string, publicKey: string) {
    await this.status();
    const key = z
      .object({ nonce: z.number().int().nonnegative().safe(), permission: z.literal("FullAccess"), block_hash: hash })
      .safeParse(
        await this.rpc("query", {
          request_type: "view_access_key",
          account_id: mainnetAccount(accountId),
          public_key: publicKey,
          finality: "final",
        }),
      );
    if (!key.success)
      throw new AshError(
        "UNSAFE_OPERATION",
        "The configured signing key must match a mainnet full-access key; function-call keys cannot attach deposits.",
      );
    const gas = z.object({ gas_price: z.string().regex(/^[1-9]\d*$/) }).safeParse(await this.rpc("gas_price", [null]));
    const protocol = z
      .object({ runtime_config: z.object({ storage_amount_per_byte: z.string().regex(/^[1-9]\d*$/) }) })
      .safeParse(await this.rpc("EXPERIMENTAL_protocol_config", { finality: "final" }));
    if (!gas.success || !protocol.success)
      throw new AshError("MARKET_PROTOCOL_ERROR", "Cannot establish gas and account storage costs.");
    return {
      nonce: BigInt(key.data.nonce),
      block_hash: key.data.block_hash,
      gas_price: BigInt(gas.data.gas_price),
      storage_price: BigInt(protocol.data.runtime_config.storage_amount_per_byte),
    };
  }

  async broadcastSignedTransaction(encoded: string): Promise<unknown> {
    return this.rpc("broadcast_tx_commit", [encoded]);
  }

  async transaction(txHash: string, signer: string): Promise<unknown> {
    await this.status();
    if (!hash.safeParse(txHash).success) throw new AshError("VALIDATION_FAILED", "Invalid transaction hash.");
    return this.rpc("tx", { tx_hash: txHash, sender_account_id: mainnetAccount(signer), wait_until: "FINAL" });
  }

  async account(accountId = this.config.account ?? "") {
    const accountIdValid = mainnetAccount(accountId);
    await this.status();
    const result = z
      .object({
        amount: z.string().regex(/^\d+$/),
        locked: z.string().regex(/^\d+$/),
        code_hash: hash,
        storage_usage: z.number().int().nonnegative(),
        block_height: z.number().int().positive(),
        block_hash: hash,
      })
      .safeParse(
        await this.rpc("query", { request_type: "view_account", account_id: accountIdValid, finality: "final" }),
      );
    if (!result.success) throw new AshError("MARKET_PROTOCOL_ERROR", "Mainnet account response is invalid.");
    return { account_id: accountIdValid, network: "mainnet" as const, finality: "final", ...result.data };
  }

  async accessKeys(accountId: string) {
    const id = mainnetAccount(accountId);
    await this.status();
    const result = z
      .object({
        keys: z.array(
          z.object({
            public_key: z.string(),
            access_key: z.object({
              nonce: z.number().int().nonnegative(),
              permission: z.union([
                z.literal("FullAccess"),
                z.object({
                  FunctionCall: z.object({
                    allowance: z.string().nullable(),
                    receiver_id: account,
                    method_names: z.array(z.string()),
                  }),
                }),
              ]),
            }),
          }),
        ),
        block_height: z.number().int().positive(),
      })
      .safeParse(await this.rpc("query", { request_type: "view_access_key_list", account_id: id, finality: "final" }));
    if (!result.success) throw new AshError("MARKET_PROTOCOL_ERROR", "Mainnet access-key response is invalid.");
    return {
      account_id: id,
      network: "mainnet" as const,
      ...result.data,
      note: "Public permissions only. This read never accesses a private key. The optional operator signer uses a local full-access key with local spending policy.",
    };
  }

  async tokens() {
    const result = z
      .array(tokenSchema)
      .min(1)
      .safeParse(await this.request(`${this.config.oneClickUrl}/tokens`));
    if (!result.success) throw new AshError("MARKET_PROTOCOL_ERROR", "1Click token catalogue is invalid.");
    return result.data;
  }

  async dryQuote(input: DryQuoteInput) {
    const parsed = DryQuoteInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError(
        "VALIDATION_FAILED",
        "Invalid dry quote: use atomic amounts, a mainnet recipient and at most 100 slippage basis points.",
      );
    const request = parsed.data;
    assertText(request.refund_to, "Refund wallet address", 200);
    const tokens = await this.tokens();
    const origin = tokens.find((token) => token.assetId === request.origin_asset);
    const destination = tokens.find((token) => token.assetId === request.destination_asset);
    if (!origin || !destination || destination.blockchain !== "near")
      throw new AshError(
        "VALIDATION_FAILED",
        "Select supported assets with a NEAR destination from the live 1Click catalogue.",
      );
    if (origin.assetId === destination.assetId)
      throw new AshError("VALIDATION_FAILED", "Origin and destination assets must differ.");
    if (origin.blockchain === "near") mainnetAccount(request.refund_to);
    const body = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: request.slippage_bps,
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      depositType: "ORIGIN_CHAIN",
      amount: request.amount_atomic,
      refundTo: request.refund_to,
      refundType: "ORIGIN_CHAIN",
      recipient: request.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    const result = z
      .object({
        quoteRequest: z.object({
          dry: z.literal(true),
          originAsset: z.literal(body.originAsset),
          destinationAsset: z.literal(body.destinationAsset),
          amount: z.literal(body.amount),
          recipient: z.literal(body.recipient),
          refundTo: z.literal(body.refundTo),
          swapType: z.literal("EXACT_INPUT"),
          depositType: z.literal("ORIGIN_CHAIN"),
          recipientType: z.literal("DESTINATION_CHAIN"),
        }),
        quote: z.object({
          amountIn: atomic,
          amountOut: atomic,
          minAmountOut: atomic,
          depositAddress: z.undefined().optional(),
          depositMemo: z.undefined().optional(),
          chainDepositAddresses: z.undefined().optional(),
        }),
      })
      .safeParse(await this.request(`${this.config.oneClickUrl}/quote`, body));
    if (
      !result.success ||
      result.data.quote.amountIn !== body.amount ||
      BigInt(result.data.quote.minAmountOut) > BigInt(result.data.quote.amountOut)
    )
      throw new AshError("MARKET_PROTOCOL_ERROR", "1Click returned a mismatched or fundable response to a dry quote.");
    return {
      network: "mainnet",
      mode: "DRY_QUOTE",
      paid: false,
      funds_spent: "0",
      signed: false,
      request: body,
      quote: result.data.quote,
      evidence_sha256: hashJson(result.data),
    };
  }

  async verifyTransfer(input: TransferProof, daoPayout?: { account: string; proposal_id: number }) {
    const parsed = TransferProofSchema.safeParse(input);
    if (!parsed.success)
      throw new AshError(
        "VALIDATION_FAILED",
        "Invalid transfer proof: provide mainnet accounts, a transaction hash and a positive atomic amount.",
      );
    const expected = parsed.data;
    await this.status();
    const parsedTx = transactionSchema.safeParse(
      await this.rpc("tx", {
        tx_hash: expected.tx_hash,
        sender_account_id: expected.signer_account,
        wait_until: "FINAL",
      }),
    );
    if (!parsedTx.success)
      throw new AshError(
        "VERIFICATION_FAILED",
        "The transaction is not FINAL with successful execution of every receipt.",
      );
    const tx = parsedTx.data;
    if (tx.transaction.hash !== expected.tx_hash || tx.transaction.signer_id !== expected.signer_account)
      throw new AshError("VERIFICATION_FAILED", "Transaction identity differs from the expected proof.");
    if (new Set(tx.receipts_outcome.map((receipt) => receipt.id)).size !== tx.receipts_outcome.length)
      throw new AshError("VERIFICATION_FAILED", "Duplicate receipt outcomes cannot establish a payment.");
    if (daoPayout) {
      const approved = tx.transaction.actions?.some((action) => {
        const call = z
          .object({ FunctionCall: z.object({ method_name: z.literal("act_proposal"), args: z.string() }) })
          .safeParse(action);
        if (!call.success) return false;
        try {
          const args = JSON.parse(Buffer.from(call.data.FunctionCall.args, "base64").toString("utf8"));
          return args.id === daoPayout.proposal_id && args.action === "VoteApprove";
        } catch {
          return false;
        }
      });
      if (tx.transaction.receiver_id !== daoPayout.account || !approved)
        throw new AshError(
          "VERIFICATION_FAILED",
          "Payout transaction is not approval execution of the expected DAO proposal.",
        );
    }
    const matches: Array<{
      receipt_id: string;
      block_hash: string;
      log_index: number;
      data_index: number;
      amount_atomic: string;
    }> = [];
    for (const receipt of tx.receipts_outcome) {
      if (receipt.outcome.executor_id !== expected.token_account) continue;
      receipt.outcome.logs.forEach((log, logIndex) => {
        if (!log.startsWith("EVENT_JSON:")) return;
        let event: unknown;
        try {
          event = JSON.parse(log.slice("EVENT_JSON:".length));
        } catch {
          return;
        }
        const parsedEvent = z
          .object({
            standard: z.literal("nep141"),
            version: z.literal("1.0.0"),
            event: z.literal("ft_transfer"),
            data: z.array(z.object({ old_owner_id: z.string(), new_owner_id: z.string(), amount: atomic })),
          })
          .safeParse(event);
        if (!parsedEvent.success) return;
        parsedEvent.data.data.forEach((line, dataIndex) => {
          if (line.old_owner_id === expected.sender_account && line.new_owner_id === expected.recipient_account)
            matches.push({
              receipt_id: receipt.id,
              block_hash: receipt.block_hash,
              log_index: logIndex,
              data_index: dataIndex,
              amount_atomic: line.amount,
            });
        });
      });
    }
    const transferred = matches.reduce((sum, line) => sum + BigInt(line.amount_atomic), 0n);
    if (!matches.length || transferred !== BigInt(expected.amount_atomic))
      throw new AshError(
        "VERIFICATION_FAILED",
        "No exact NEP-141 transfer matches the token, sender, recipient and amount.",
      );
    // A ft_transfer_call can be refunded later in the same successful transaction.
    // Reject reverse transfer events rather than counting the initial transfer as paid.
    for (const receipt of tx.receipts_outcome.filter((item) => item.outcome.executor_id === expected.token_account)) {
      for (const log of receipt.outcome.logs) {
        if (!log.startsWith("EVENT_JSON:")) continue;
        try {
          const event = JSON.parse(log.slice("EVENT_JSON:".length));
          if (
            event.standard === "nep141" &&
            event.event === "ft_transfer" &&
            Array.isArray(event.data) &&
            event.data.some((line: Record<string, unknown>) => line.old_owner_id === expected.recipient_account)
          )
            throw new AshError(
              "VERIFICATION_FAILED",
              "Recipient tokens moved again in the transaction; settlement requires reconciliation.",
            );
        } catch (error) {
          if (error instanceof AshError) throw error;
        }
      }
    }
    return {
      network: "mainnet" as const,
      status: "VERIFIED_TRANSFER" as const,
      finality: "FINAL",
      expected,
      events: matches,
      evidence_sha256: hashJson(tx),
      verified_at: new Date().toISOString(),
      note: "Verifies this token transfer only; does not establish all track workflows or market delivery.",
    };
  }

  async daoProposal(daoAccount: string, proposalId: number) {
    const dao = mainnetAccount(daoAccount);
    if (!Number.isSafeInteger(proposalId) || proposalId < 0)
      throw new AshError("VALIDATION_FAILED", "Proposal ID must be a nonnegative safe integer.");
    await this.status();
    const response = z
      .object({
        result: z.array(z.number().int().min(0).max(255)),
        block_height: z.number().int().positive(),
        block_hash: hash,
      })
      .safeParse(
        await this.rpc("query", {
          request_type: "call_function",
          account_id: dao,
          method_name: "get_proposal",
          args_base64: Buffer.from(JSON.stringify({ id: proposalId })).toString("base64"),
          finality: "final",
        }),
      );
    if (!response.success) throw new AshError("MARKET_PROTOCOL_ERROR", "DAO proposal response is invalid.");
    let proposal: unknown;
    try {
      proposal = JSON.parse(Buffer.from(response.data.result).toString("utf8"));
    } catch {
      throw new AshError("MARKET_PROTOCOL_ERROR", "DAO proposal is not valid JSON.");
    }
    const parsed = z
      .object({
        id: z.literal(proposalId),
        proposer: account,
        status: z.string(),
        kind: z.record(z.string(), z.unknown()),
      })
      .safeParse(proposal);
    if (!parsed.success)
      throw new AshError("MARKET_PROTOCOL_ERROR", "DAO does not expose the supported Sputnik proposal schema.");
    return {
      network: "mainnet",
      dao_account: dao,
      proposal: parsed.data,
      block_height: response.data.block_height,
      block_hash: response.data.block_hash,
      paid: false,
      note: "A proposal or Approved status does not prove payout; verify the separate token transfer.",
    };
  }

  private async tokenView(tokenAccount: string, ownerAccount: string, method: "ft_balance_of" | "storage_balance_of") {
    const token = mainnetAccount(tokenAccount);
    const owner = mainnetAccount(ownerAccount);
    await this.status();
    const response = z
      .object({
        result: z.array(z.number().int().min(0).max(255)),
        block_height: z.number().int().positive(),
        block_hash: hash,
      })
      .safeParse(
        await this.rpc("query", {
          request_type: "call_function",
          account_id: token,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify({ account_id: owner })).toString("base64"),
          finality: "final",
        }),
      );
    if (!response.success) throw new AshError("MARKET_PROTOCOL_ERROR", "Token contract view response is invalid.");
    let result: unknown;
    try {
      result = JSON.parse(Buffer.from(response.data.result).toString("utf8"));
    } catch {
      throw new AshError("MARKET_PROTOCOL_ERROR", "Token contract returned invalid JSON.");
    }
    return { result, block_height: response.data.block_height, block_hash: response.data.block_hash };
  }

  async tokenBalance(tokenAccount: string, ownerAccount: string) {
    const view = await this.tokenView(tokenAccount, ownerAccount, "ft_balance_of");
    const parsed = z
      .string()
      .regex(/^(0|[1-9]\d{0,77})$/)
      .safeParse(view.result);
    if (!parsed.success) throw new AshError("MARKET_PROTOCOL_ERROR", "Token balance is not a valid atomic amount.");
    return {
      network: "mainnet",
      token_account: tokenAccount,
      owner_account: ownerAccount,
      balance_atomic: parsed.data,
      block_height: view.block_height,
      block_hash: view.block_hash,
    };
  }

  async tokenStorage(tokenAccount: string, ownerAccount: string) {
    const view = await this.tokenView(tokenAccount, ownerAccount, "storage_balance_of");
    const parsed = z
      .object({ total: z.string().regex(/^\d+$/), available: z.string().regex(/^\d+$/) })
      .nullable()
      .safeParse(view.result);
    if (!parsed.success) throw new AshError("MARKET_PROTOCOL_ERROR", "Token storage registration response is invalid.");
    return {
      network: "mainnet",
      token_account: tokenAccount,
      owner_account: ownerAccount,
      registered: parsed.data !== null,
      block_height: view.block_height,
      block_hash: view.block_hash,
    };
  }
}
