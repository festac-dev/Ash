import assert from "node:assert/strict";
import test from "node:test";
import { startAshServer } from "../src/server/server.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";

const TOKEN = "track-api-test-token-0123456789";

test("public track catalog and authenticated local verification", async () => {
  const dir = await tempDir();
  const server = await startAshServer({ config: testConfig(dir), token: TOKEN });
  try {
    const catalogResponse = await fetch(`${server.session.url}/api/tracks`);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as {
      tracks: Array<{ id: string; live_status: string }>;
      providers: Array<{ authoritative: boolean }>;
      mode: string;
    };
    assert.equal(catalog.mode, "LOCAL_SIMULATION");
    assert.deepEqual(
      catalog.tracks.map((track) => track.id),
      ["realworld", "business", "security", "privacy", "swarms", "social"],
    );
    assert.ok(catalog.tracks.every((track) => track.live_status !== "live"));
    assert.ok(catalog.providers.every((provider) => provider.authoritative === false));

    const denied = await fetch(`${server.session.url}/api/tracks/verify`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);

    const verified = await fetch(`${server.session.url}/api/tracks/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(verified.status, 200);
    const journey = (await verified.json()) as {
      all_passed: boolean;
      passed: number;
      steps: Array<{ status: string; track_id: string }>;
    };
    assert.equal(journey.all_passed, true);
    assert.equal(journey.passed, 6);
    assert.deepEqual(
      journey.steps.map((step) => step.track_id),
      ["realworld", "security", "business", "swarms", "privacy", "social"],
    );
    assert.ok(journey.steps.every((step) => step.status === "PASS"));

    const single = await fetch(`${server.session.url}/api/tracks/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ track_id: "security" }),
    });
    assert.equal(single.status, 200);
    const singlePayload = (await single.json()) as { track: { track_id: string; checks: Array<{ passed: boolean }> } };
    assert.equal(singlePayload.track.track_id, "security");
    assert.ok(singlePayload.track.checks.every((check) => check.passed));
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
