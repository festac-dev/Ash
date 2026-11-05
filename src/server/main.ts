import { loadConfig, loadDotEnv } from "../config.js";
import { AshError, errorMessage, isAshError } from "../errors.js";
import { startAshServer } from "./server.js";
import { redact } from "../util/redact.js";
import { logger } from "../logger.js";

/**
 * Standalone Ash API process. The launcher starts this through `ash server start`
 * or as a managed child; it also works with `node dist/server/main.js`.
 */
export async function runServerMain(): Promise<number> {
  let config;
  try {
    loadDotEnv();
    config = loadConfig();
    if (!config.simulation && config.model.provider === "none")
      throw new AshError(
        "CONFIG_INVALID",
        "No model provider configured. Set ASH_MODEL_* or run npm run demo without NODE_ENV=production.",
      );
  } catch (error) {
    const message = isAshError(error) ? error.message : errorMessage(error);
    process.stderr.write(`ASH SERVER CONFIGURATION ERROR\n${redact(message)}\n`);
    return 2;
  }

  const { host, port, token, allowRemote, publicUrl, secureCookies, ui } = config.server;

  try {
    const localCore = process.env.ASH_LOCAL_CORE === "1" && !allowRemote;
    const running = await startAshServer({
      config,
      host,
      port: localCore ? 0 : port,
      token,
      allowRemote,
      publicUrl,
      secureCookies,
      ui: localCore ? false : ui,
      inlineFrontend: !localCore,
    });
    process.stdout.write(`Ash API listening on ${running.session.url} (pid ${process.pid})\n`);
    const stop = (): void => {
      void running.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("uncaughtException", (error) => {
      process.stderr.write(`Ash API uncaught failure: ${redact(error.message)}\n`);
      void running.close().finally(() => process.exit(1));
    });
    return 0;
  } catch (error) {
    const message = isAshError(error) ? error.message : errorMessage(error);
    const hint = isAshError(error) ? error.hint : undefined;
    process.stderr.write(`ASH SERVER ERROR: ${redact(message)}\n${hint ? `Hint: ${hint}\n` : ""}`);
    logger.error("API server failed to start", { error: message, code: isAshError(error) ? error.code : "UNKNOWN" });
    return isAshError(error) && error.code === "CONFIG_INVALID" ? 2 : 1;
  }
}

if (process.argv[1] && /server[\\/]main\.(?:ts|js)$/.test(process.argv[1])) {
  void runServerMain().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

export function isAshServerError(error: unknown): error is AshError {
  return isAshError(error);
}
