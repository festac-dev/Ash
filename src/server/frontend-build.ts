import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AshError } from "../errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let building: Promise<void> | null = null;
async function newest(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const times = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? newest(file) : (await fs.stat(file)).mtimeMs;
    }),
  );
  return Math.max(0, ...times);
}

/** Frontend tooling is loaded only on B / npm run web, never on CLI startup. */
export async function ensureFrontendBuild(): Promise<void> {
  if (building) return building;
  const work = (async () => {
    const stamp = await fs.stat(path.join(root, "dist/.frontend-built")).catch(() => null);
    const entry = await fs.stat(path.join(root, "dist/web/index.html")).catch(() => null);
    if (process.env.NODE_ENV === "production") {
      if (!entry?.isFile())
        throw new AshError("CONFIG_INVALID", "Frontend assets are missing. Run npm run build before deploying Ash.");
      const html = await fs.readFile(path.join(root, "dist/web/index.html"), "utf8");
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[\w.-]+)"/g)].map((match) => match[1]!);
      for (const file of ["/workspace.html", "/console.html", "/app.js", "/styles.css", ...assets]) {
        const asset = await fs.stat(path.join(root, "dist/web", file)).catch(() => null);
        if (!asset?.isFile())
          throw new AshError(
            "CONFIG_INVALID",
            `Frontend asset ${file} is missing. Run npm run build before deploying Ash.`,
          );
      }
      return; // Production images contain compiled assets, not source or build tools.
    }
    const changed = Math.max(
      await newest(path.join(root, "frontend")),
      await newest(path.join(root, "web")),
      (await fs.stat(path.join(root, "scripts/build-web.mjs"))).mtimeMs,
      (await fs.stat(path.join(root, "package.json"))).mtimeMs,
    );
    if (stamp && entry && stamp.mtimeMs >= changed) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "scripts/build-web.mjs")], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-3000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new AshError("STATE_INVALID", `Frontend build failed. The CLI remains available. ${output}`)),
      );
    });
  })();
  building = work;
  try {
    await work;
  } finally {
    building = null;
  }
}
