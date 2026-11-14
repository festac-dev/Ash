import type { AppConfig } from "../config.js";
import { AshError } from "../errors.js";
import { MarketOAuth } from "../market/oauth.js";

export async function runMarketAuth(config: AppConfig, args: string[]): Promise<number> {
  if (config.simulation) throw new AshError("UNSAFE_OPERATION", "Marketplace OAuth is unavailable in demo mode.");
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  if (words.length !== 1)
    throw new AshError("VALIDATION_FAILED", "Usage: ash market <login|auth-status|logout> [--json]");
  const oauth = new MarketOAuth(config);
  let data: unknown;
  if (words[0] === "login") {
    if (json)
      throw new AshError(
        "VALIDATION_FAILED",
        "market login displays a private consent code in the operator terminal; --json is unavailable.",
      );
    const challenge = await oauth.start();
    process.stdout.write(
      `Open ${challenge.verification_uri}\nSign into your NEAR AI Agent Market account using the site's sign-in options.\nEnter code: ${challenge.user_code}\nApprove Ash as yourself on the consent page. Keep this terminal running.\nThis grants account access; hires and payments still need separate approval.\n`,
    );
    data = await oauth.finish(challenge);
    process.stdout.write("Marketplace credentials saved locally. Use ash market to check buyer permissions.\n");
  } else if (words[0] === "auth-status") data = await oauth.status();
  else if (words[0] === "logout") data = await oauth.logout();
  else throw new AshError("VALIDATION_FAILED", "Usage: ash market <login|auth-status|logout> [--json]");
  process.stdout.write(
    `${JSON.stringify(json ? { schema_version: 1, command: "market-auth", ok: true, simulated: false, data } : data, null, json ? undefined : 2)}\n`,
  );
  return 0;
}
