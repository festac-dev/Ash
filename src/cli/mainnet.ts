import { promises as fs } from "node:fs";
import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { MainnetService } from "../server/mainnet-service.js";
import { MainnetSigner } from "../server/mainnet-signer.js";
import { runLiveWorkflow } from "../trackflows/live.js";
import { MainnetPolicy, mainnetApprovalView } from "../server/mainnet-policy.js";
import { z } from "zod";

export async function runMainnetCommand(config: AppConfig, args: string[]): Promise<number> {
  if (config.simulation)
    throw new AshError("UNSAFE_OPERATION", "Mainnet operations require live mode and never fall back to fixtures.");
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const [action = "check", value, workflowFile] = words;
  const service = new MainnetService(config);
  await service.initialize();
  let data: unknown;
  if (words.length > (action === "workflow" ? 3 : 2))
    throw new AshError(
      "VALIDATION_FAILED",
      "Usage: ash mainnet <check [account]|keys account|quote file|verify file|payments|spending|request file|approve file|send file|enable|disable|evidence|reconcile reference|workflow operation file> [--json]",
    );
  if (action === "check") data = await service.check(value);
  else if (action === "payments" && !value) data = await service.payments();
  else if (action === "evidence" && !value) data = await service.evidence();
  else if (action === "spending" && !value) data = await new MainnetSigner(config).status();
  else if ((action === "enable" || action === "disable") && !value)
    data = await new MainnetPolicy(config).setEnabled(action === "enable");
  else if (action === "reconcile" && value) data = await new MainnetSigner(config).reconcile(value);
  else if (action === "keys" && value) data = await service.client.accessKeys(value);
  else if (
    ((action === "quote" || action === "verify" || action === "send" || action === "request" || action === "approve") &&
      value) ||
    (action === "workflow" && value && workflowFile)
  ) {
    const file = action === "workflow" ? workflowFile! : value!;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 64 * 1024)
      throw new AshError("VALIDATION_FAILED", "Mainnet input must be a JSON file of at most 64 KB.");
    let input: unknown;
    try {
      input = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      throw new AshError("VALIDATION_FAILED", "Mainnet input is not valid JSON.");
    }
    if (action === "request") data = await new MainnetPolicy(config).request(input);
    else if (action === "approve") {
      const decision = z.object({ approval_id: z.string(), phrase: z.string() }).strict().parse(input);
      data = mainnetApprovalView(
        await new MainnetPolicy(config).approvals().decide(decision.approval_id, "approved", decision.phrase),
      );
    } else
      data =
        action === "workflow"
          ? await runLiveWorkflow(config, value!, input)
          : action === "send"
            ? await new MainnetSigner(config).send(input)
            : action === "quote"
              ? await service.quote(input)
              : await service.verifyPayment(input);
  } else
    throw new AshError(
      "VALIDATION_FAILED",
      "Usage: ash mainnet <check [account]|keys account|quote file|verify file|payments|spending|request file|approve file|send file|enable|disable|evidence|reconcile reference|workflow operation file> [--json]",
    );
  process.stdout.write(
    `${JSON.stringify(json ? { schema_version: 1, command: "mainnet", ok: true, simulated: false, data } : data, null, json ? undefined : 2)}\n`,
  );
  return 0;
}
