import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { createServices } from "./services.js";
import { AshService } from "../server/service.js";
import { EventBus } from "../server/event-bus.js";
import { runJourney, runTrack, persistJourney, persistTrackRun } from "../journey/index.js";
import { TRACK_MODULE_LIST } from "../trackflows/index.js";
import { redactObject } from "../util/redact.js";

/** Structured output is produced from services, never by scraping terminal text. */
export async function runJsonCommand(config: AppConfig, command: string, args: string[]): Promise<number> {
  const services = await createServices(config);
  const service = new AshService(services, new EventBus(), new Date().toISOString(), process.pid);
  let data: unknown;
  let ok = true;
  try {
    switch (command) {
      case "status":
        data = await service.state();
        break;
      case "tasks":
        data = await service.tasks();
        break;
      case "budget":
        data = (await service.state()).ledger;
        break;
      case "approvals":
        data = (await service.state()).approvals;
        break;
      case "settings":
        if (args.length)
          throw new AshError(
            "VALIDATION_FAILED",
            "JSON settings are read-only. Use the interactive settings command to edit.",
          );
        data = await service.settings();
        break;
      case "history":
        data = await service.timeline("active");
        break;
      case "export":
        data = await service.exportProof("active");
        break;
      case "verify": {
        const result = await services.transactions.verify();
        data = result;
        ok = result.ok;
        break;
      }
      case "transactions": {
        const result = await services.transactions.inspect(100);
        data = result;
        ok = result.report.ok;
        break;
      }
      case "agents":
        await service.initialize();
        data = await service.agents(args.join(" "));
        break;
      case "jobs":
        await service.initialize();
        data = await service.jobs();
        break;
      case "market":
        await service.initialize();
        data = await service.market();
        break;
      case "tracks": {
        if (!config.simulation)
          throw new AshError(
            "UNSAFE_OPERATION",
            "Track fixtures require npm run demo; they are not live provider results.",
          );
        if (args[0] === "run" || args[0] === "verify") {
          const target = args[1] ?? "all";
          if (target === "all") {
            const result = runJourney();
            data = { ...result, evidence_path: await persistJourney(config.dataDir, result) };
            ok = result.all_passed;
          } else {
            const result = runTrack(target);
            data = { ...result, evidence_path: await persistTrackRun(config.dataDir, result) };
            ok = result.checks.every((check) => check.passed);
          }
        } else data = TRACK_MODULE_LIST;
        break;
      }
      default:
        throw new AshError("VALIDATION_FAILED", `--json is not supported for ${command}. Run ash ${command} --help.`);
    }
    process.stdout.write(
      `${JSON.stringify({ schema_version: 1, command, ok, simulated: config.simulation || command === "tracks", data: redactObject(data) })}\n`,
    );
    return ok ? 0 : 5;
  } finally {
    await services.engine.stop();
    await services.market.disconnect();
  }
}
