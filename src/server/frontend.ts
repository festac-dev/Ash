import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AshError } from "../errors.js";

export interface FrontendStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  next_action: "start" | "code" | "stop";
}

/** Owns only the browser listener. Stopping it never stops the engine or core API. */
export class FrontendServer {
  private server: Server | null = null;
  private inlineUrl: string | null = null;
  private inlineRunning = false;
  private codeIssued = false;
  private inlinePort: number | null = null;
  suppressed = false;
  attach(url: string, running: boolean, port: number): void {
    this.inlineUrl = url;
    this.inlinePort = port;
    this.inlineRunning = running;
  }
  private readonly clients = new Set<ServerResponse>();
  private transition: Promise<FrontendStatus> | null = null;
  private closed = false;
  private url: string | null = null;
  constructor(
    private readonly port: number,
    private readonly handle: (
      req: IncomingMessage,
      res: ServerResponse,
      clients: Set<ServerResponse>,
      url: string,
    ) => void,
    private readonly prepare: () => Promise<void> = async () => {},
  ) {}

  status(): FrontendStatus {
    const running = Boolean(this.server) || this.inlineRunning;
    const url = this.inlineUrl ?? this.url ?? (this.port ? `http://127.0.0.1:${this.port}` : null);
    return {
      running,
      url,
      port: this.inlinePort ?? (url ? Number(new URL(url).port || 443) : null),
      next_action: !running ? "start" : this.codeIssued ? "stop" : "code",
    };
  }

  private adminBusy = false;

  async administer<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.adminBusy)
      throw new AshError("CONFLICT", "Frontend access is changing. Retry after the current action finishes.");
    this.adminBusy = true;
    try {
      return await operation();
    } finally {
      this.adminBusy = false;
    }
  }

  markCodeIssued(): void {
    this.codeIssued = true;
  }

  async setRunning(running?: boolean): Promise<FrontendStatus> {
    if (this.closed) throw new AshError("CONFLICT", "ASH is shutting down.");
    if (this.transition) throw new AshError("CONFLICT", "The frontend is already starting or stopping.");
    const desired = running ?? !this.status().running;
    const previousSuppressed = this.suppressed;
    this.suppressed = !desired;
    const work = desired ? this.start() : this.stop();
    this.transition = work;
    try {
      return await work;
    } catch (error) {
      this.suppressed = previousSuppressed;
      throw error;
    } finally {
      this.transition = null;
    }
  }

  private async start(): Promise<FrontendStatus> {
    if (this.inlineUrl) {
      if (!this.inlineRunning) await this.prepare();
      this.inlineRunning = true;
      return this.status();
    }
    if (this.server) return this.status();
    await this.prepare();
    if (this.closed) throw new AshError("CONFLICT", "ASH is shutting down.");
    const server = createServer((req, res) => this.handle(req, res, this.clients, this.url ?? ""));
    server.headersTimeout = 30_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      throw new AshError(
        "CONFLICT",
        `Cannot start the frontend on port ${this.port}: ${(error as Error).message}. Set ASH_SERVER_PORT to a free port.`,
        { cause: error },
      );
    }
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.status();
  }

  private async stop(): Promise<FrontendStatus> {
    this.codeIssued = false;
    if (this.inlineUrl) {
      this.inlineRunning = false;
      return this.status();
    }
    const server = this.server;
    if (!server) return this.status();
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
      server.closeAllConnections();
    });
    this.server = null;

    return this.status();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transition?.catch(() => undefined);
    await this.stop();
  }
}
