import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { startAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig, waitFor } from "./helpers.js";

const TOKEN = "tls-integration-token-0123456789abcdef";

test("nginx TLS proxy preserves auth, secure cookies, CSRF and live SSE", { timeout: 60_000 }, async () => {
  const nginx = process.env.ASH_NGINX_BIN ?? "nginx";
  execFileSync(nginx, ["-v"], { stdio: "pipe" });
  const dir = await tempDir();
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `https://localhost:${port}`;
  const server = await startAshServer({
    config: testConfig(dir),
    token: TOKEN,
    publicUrl: origin,
    secureCookies: "always",
  });
  let proxy: ReturnType<typeof spawn> | undefined;
  let events: http.IncomingMessage | undefined;
  try {
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    const values: Record<string, string> = {
      ASH_TLS_PORT: String(port),
      ASH_PUBLIC_HOST: "localhost",
      ASH_TLS_CERT: cert,
      ASH_TLS_KEY: key,
      ASH_UPSTREAM_PORT: new URL(server.session.url).port,
    };
    const template = await fs.readFile(path.resolve("deploy/nginx-ash.conf.template"), "utf8");
    const block = template.replace(/\$\{(ASH_\w+)\}/g, (_, name: string) => {
      assert.ok(values[name], `missing template variable ${name}`);
      return values[name]!;
    });
    const conf = path.join(dir, "nginx.conf");
    await fs.writeFile(
      conf,
      `daemon off;\nmaster_process off;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents {}\nhttp { access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; fastcgi_temp_path ${dir}/fastcgi; uwsgi_temp_path ${dir}/uwsgi; scgi_temp_path ${dir}/scgi; ${block} }\n`,
    );
    execFileSync(nginx, ["-t", "-p", `${dir}/`, "-c", conf], { stdio: "pipe" });
    proxy = spawn(nginx, ["-p", `${dir}/`, "-c", conf], { stdio: ["ignore", "ignore", "pipe"] });
    let proxyLog = "";
    proxy.stderr!.on("data", (chunk: Buffer) => {
      proxyLog += chunk.toString();
    });
    const ca = await fs.readFile(cert);
    const request = (
      route: string,
      options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
    ) =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            servername: "localhost",
            port,
            ca,
            path: route,
            method: options.method ?? "GET",
            headers: {
              Origin: origin,
              ...(options.body ? { "Content-Type": "application/json" } : {}),
              ...options.headers,
            },
          },
          resolve,
        );
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("TLS request timed out")));
        req.end(options.body ? JSON.stringify(options.body) : undefined);
      });
    const read = async (response: http.IncomingMessage): Promise<string> => {
      let text = "";
      for await (const chunk of response) text += String(chunk);
      return text;
    };
    await waitFor(
      async () => {
        if (proxy!.exitCode !== null) throw new Error(`nginx exited: ${proxyLog}`);
        try {
          const response = await request("/");
          await read(response);
          return response.statusCode === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 10_000, label: "TLS proxy" },
    );
    const unauthorized = await request("/api/state");
    assert.equal(unauthorized.statusCode, 401);
    await read(unauthorized);
    const issued = await fetch(`${server.session.url}/api/frontend/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(issued.status, 200);
    const { code } = (await issued.json()) as { code: string };
    const deniedAdmin = await request("/api/frontend/code", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(deniedAdmin.statusCode, 403);
    await read(deniedAdmin);
    const login = await request("/api/auth/login", { method: "POST", body: { code } });
    assert.equal(login.statusCode, 200);
    const setCookie = login.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.equal(setCookie.includes(TOKEN), false);
    const cookie = setCookie.split(";")[0]!;
    await read(login);
    const replay = await request("/api/auth/login", { method: "POST", body: { code } });
    assert.equal(replay.statusCode, 401);
    await read(replay);
    const state = await request("/api/state", { headers: { Cookie: cookie } });
    assert.equal(state.statusCode, 200);
    assert.equal(JSON.parse(await read(state)).mode, "SIMULATION");
    const rejectedHeaders: Record<string, string>[] = [
      { Cookie: cookie },
      { Cookie: cookie, "X-Ash-Client": "web", Origin: "https://evil.example" },
    ];
    for (const headers of rejectedHeaders) {
      const rejected = await request("/api/tasks", {
        method: "POST",
        headers,
        body: { description: "Reject cross-site task creation", budget: "5", currency: "USDC" },
      });
      assert.equal(rejected.statusCode, 403);
      await read(rejected);
    }
    events = await request("/api/events", { headers: { Cookie: cookie } });
    assert.equal(events.statusCode, 200);
    assert.match(events.headers["content-type"] ?? "", /text\/event-stream/);
    let stream = "";
    events.on("data", (chunk: Buffer) => {
      stream += chunk.toString();
    });
    const created = await request("/api/tasks", {
      method: "POST",
      headers: { Cookie: cookie, "X-Ash-Client": "web" },
      body: { description: "Create a task through the TLS reverse proxy", budget: "5", currency: "USDC" },
    });
    assert.equal(created.statusCode, 201);
    await read(created);
    await waitFor(async () => stream.includes("event: refresh"), {
      timeoutMs: 5000,
      label: "unbuffered SSE refresh event",
    });
    const bearer = await request("/api/health", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(bearer.statusCode, 200);
    await read(bearer);
    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, "X-Ash-Client": "web" },
      body: {},
    });
    assert.equal(logout.statusCode, 200);
    await read(logout);
    const revoked = await request("/api/state", { headers: { Cookie: cookie } });
    assert.equal(revoked.statusCode, 401);
    await read(revoked);
  } finally {
    events?.destroy();
    if (proxy && proxy.exitCode === null) {
      const exited = once(proxy, "exit");
      proxy.kill("SIGTERM");
      await exited;
    }
    await server.close();
    await cleanup(dir);
  }
});
