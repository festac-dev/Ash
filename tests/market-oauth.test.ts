import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MarketOAuth, oauthConfigured, oauthFile } from "../src/market/oauth.js";
import { publicConfig } from "../src/config.js";
import { redact } from "../src/util/redact.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

function provider(dir: string) {
  const config = testConfig(dir, { ASH_DEMO: "0", ASH_SIMULATE: "false", ASH_MODEL_PROVIDER: "none" });
  let now = 1700000000000;
  let refreshes = 0;
  let registrations = 0;
  const sleeps: number[] = [];
  const polls: string[] = ["authorization_pending", "slow_down", "success"];
  let crossOrigin = false;
  let refreshDenied = false;
  const fetcher = (async (url, init) => {
    assert.equal(init!.redirect, "error");
    assert.equal(new URL(String(url)).origin, "https://market.near.ai");
    const route = new URL(String(url)).pathname;
    const form = new URLSearchParams(String(init?.body));
    if (route.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://market.near.ai/mcp",
        authorization_servers: ["https://market.near.ai"],
      });
    if (route.includes("oauth-authorization-server"))
      return Response.json({
        issuer: "https://market.near.ai",
        registration_endpoint: "https://market.near.ai/oauth/register",
        token_endpoint: crossOrigin ? "https://evil.example/token" : "https://market.near.ai/oauth/token",
        device_authorization_endpoint: "https://market.near.ai/oauth/device/code",
        revocation_endpoint: "https://market.near.ai/oauth/revoke",
        grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        scopes_supported: ["mcp", "profile", "hiring"],
      });
    if (route === "/oauth/register") {
      assert.deepEqual(JSON.parse(String(init!.body)).redirect_uris, ["http://127.0.0.1:8765/oauth/callback"]);
      registrations++;
      return Response.json({ client_id: "ash-test-public", token_endpoint_auth_method: "none" });
    }
    if (route === "/oauth/device/code") {
      assert.equal(form.get("scope"), "mcp profile hiring");
      assert.equal(form.get("resource"), "https://market.near.ai/mcp");
      return Response.json({
        device_code: "private-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://market.near.ai/oauth/device",
        expires_in: 120,
        interval: 2,
      });
    }
    if (route === "/oauth/revoke") return new Response(null, { status: 204 });
    assert.equal(route, "/oauth/token");
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(form.get("refresh_token"), "private-refresh-token");
      if (refreshDenied) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "refreshed-access-token-long-enough",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp profile hiring",
      });
    }
    assert.equal(form.get("device_code"), "private-device-secret");
    const status = polls.shift() ?? "success";
    if (status !== "success") return Response.json({ error: status }, { status: 400 });
    return Response.json({
      access_token: "private-access-token-long-enough",
      refresh_token: "private-refresh-token",
      token_type: "Bearer",
      expires_in: 60,
      scope: "mcp profile hiring",
    });
  }) as typeof fetch;
  const oauth = new MarketOAuth(config, {
    fetcher,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return {
    config,
    oauth,
    fetcher,
    sleeps,
    polls,
    registrations: () => registrations,
    refreshes: () => refreshes,
    advance: (ms: number) => {
      now += ms;
    },
    crossOrigin: () => {
      crossOrigin = true;
    },
    denyRefresh: () => {
      refreshDenied = true;
    },
  };
}

test("device consent honors pending and slow-down, stores private tokens and never exposes them in status", async () => {
  const dir = await tempDir();
  try {
    const mock = provider(dir);
    const challenge = await mock.oauth.start();
    assert.equal((await mock.oauth.status()).credential_present, false);
    assert.equal(oauthConfigured(mock.config), false);
    await mock.oauth.finish(challenge);
    assert.deepEqual(mock.sleeps, [2000, 2000, 7000]);
    assert.equal(await mock.oauth.token(), "private-access-token-long-enough");
    assert.equal(publicConfig(mock.config).market_token_configured, true);
    const status = JSON.stringify(await mock.oauth.status());
    assert.ok(!status.includes("private-"));
    assert.equal(redact("private-refresh-token"), "[REDACTED]");
    assert.equal(redact(challenge.device_code), "[REDACTED]");
    assert.equal((await fs.stat(oauthFile(mock.config))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(oauthFile(mock.config)))).mode & 0o777, 0o700);
    await mock.oauth.start();
    assert.equal(mock.registrations(), 1);
  } finally {
    await cleanup(dir);
  }
});

test("expired access tokens refresh once across concurrent callers and retain rotated credentials", async () => {
  const dir = await tempDir();
  try {
    const mock = provider(dir);
    mock.polls.splice(0);
    await mock.oauth.finish(await mock.oauth.start());
    mock.advance(40000);
    const tokens = await Promise.all([mock.oauth.token(), mock.oauth.token()]);
    assert.deepEqual(tokens, ["refreshed-access-token-long-enough", "refreshed-access-token-long-enough"]);
    assert.equal(mock.refreshes(), 1);
    const state = JSON.parse(await fs.readFile(oauthFile(mock.config), "utf8"));
    assert.equal(state.tokens.refresh_token, "rotated-refresh-token");
    assert.equal((await mock.oauth.logout()).provider_revocation_confirmed, true);
    assert.equal(await mock.oauth.token(), null);
  } finally {
    await cleanup(dir);
  }
});

test("denied consent, expired devices and refused refreshes fail without usable credentials", async () => {
  const dir = await tempDir();
  try {
    const mock = provider(dir);
    mock.polls.splice(0, mock.polls.length, "access_denied");
    const denied = await mock.oauth.start();
    await assert.rejects(() => mock.oauth.finish(denied), /consent was denied/);
    assert.equal(await mock.oauth.token(), null);
    const expired = await mock.oauth.start();
    mock.advance(121000);
    await assert.rejects(() => mock.oauth.finish(expired), /expired/);
    mock.polls.splice(0);
    await mock.oauth.finish(await mock.oauth.start());
    mock.advance(40000);
    mock.denyRefresh();
    await assert.rejects(() => mock.oauth.token(), /refresh was refused/);
    assert.equal(await mock.oauth.token(), null);
  } finally {
    await cleanup(dir);
  }
});

test("untrusted discovery endpoints, loose file modes and symlinked tokens fail closed", async () => {
  const dir = await tempDir();
  try {
    const mock = provider(dir);
    mock.crossOrigin();
    await assert.rejects(() => mock.oauth.start(), /configured HTTPS marketplace origin/);
    assert.equal(mock.registrations(), 0);
    const good = provider(dir);
    good.polls.splice(0);
    await good.oauth.finish(await good.oauth.start());
    const file = oauthFile(good.config);
    await fs.chmod(file, 0o644);
    await assert.rejects(() => good.oauth.token(), /owner-only/);
    await fs.chmod(file, 0o600);
    const other = path.join(dir, "other-oauth.json");
    await fs.rename(file, other);
    await fs.symlink(other, file);
    await assert.rejects(() => good.oauth.token(), /owner-only/);
  } finally {
    await cleanup(dir);
  }
});

test("demo OAuth never requests a provider and expired tokens without refresh cannot be used", async () => {
  const dir = await tempDir();
  try {
    let requests = 0;
    const demo = new MarketOAuth(testConfig(dir), {
      fetcher: (async () => {
        requests++;
        throw Error("Unexpected provider call");
      }) as typeof fetch,
    });
    await assert.rejects(() => demo.start(), /demo mode/);
    await assert.rejects(() => demo.token(), /demo mode/);
    assert.equal(requests, 0);
    const mock = provider(dir);
    mock.polls.splice(0);
    await mock.oauth.finish(await mock.oauth.start());
    const file = oauthFile(mock.config);
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    delete state.tokens.refresh_token;
    await fs.writeFile(file, JSON.stringify(state));
    mock.advance(61000);
    await assert.rejects(() => mock.oauth.token(), /token expired/);
  } finally {
    await cleanup(dir);
  }
});
