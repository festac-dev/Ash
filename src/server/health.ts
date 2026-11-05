import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Bounded, shared storage probe. Never includes paths or credentials in public output. */
export class Readiness {
  private draining = false;
  private checkedAt = 0;
  private result = false;
  private pending: Promise<boolean> | null = null;

  constructor(private readonly dataDir: string) {}

  drain(): void {
    this.draining = true;
  }

  async check(): Promise<boolean> {
    if (this.draining) return false;
    if (Date.now() - this.checkedAt < 1_000) return this.result;
    if (!this.pending)
      this.pending = this.probe().finally(() => {
        this.pending = null;
      });
    // Keep a single underlying probe even if storage stalls. Each HTTP caller still
    // gets a bounded response, rather than accumulating more filesystem operations.
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async probe(): Promise<boolean> {
    const file = path.join(this.dataDir, `.readiness-${randomBytes(8).toString("hex")}`);
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile("ready\n");
      await handle.sync();
      this.result = !this.draining;
    } catch {
      this.result = false;
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.unlink(file).catch(() => undefined);
      }
      this.checkedAt = Date.now();
    }
    return this.result;
  }
}
