import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  TRACK_IDS,
  allChecksPass,
  persistJourney,
  persistTrackRun,
  runAllTracks,
  runJourney,
  runTrack,
} from "../src/journey/index.js";
import { TRACK_MODULE_LIST } from "../src/trackflows/index.js";
import { cleanup, tempDir } from "./helpers.js";

test("every track module returns deterministic local evidence", () => {
  for (const id of TRACK_IDS) {
    const run = runTrack(id);
    assert.equal(run.mode, "SIMULATION");
    assert.equal(run.integration.status, "local-simulation");
    assert.equal(run.integration.authoritative_provider_evidence, false);
    assert.equal(
      allChecksPass(run.checks),
      true,
      `${id}: ${run.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .join(", ")}`,
    );
    assert.ok(Object.keys(run.evidence as Record<string, unknown>).length > 0);
    assert.match(run.evidence_sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(runAllTracks().length, 6);
  assert.throws(() => runTrack("unknown"), /Unknown track/);
});

test("the shared journey runs all six tracks with deterministic decisions", () => {
  const first = runJourney();
  const second = runJourney();
  assert.equal(first.all_passed, true);
  assert.equal(first.passed, 6);
  assert.equal(first.failed, 0);
  const journeyOrder = ["realworld", "security", "business", "swarms", "privacy", "social"];
  assert.deepEqual(
    first.steps.map((step) => step.track_id),
    journeyOrder,
  );
  assert.deepEqual(
    first.steps.map((step) => step.status),
    TRACK_IDS.map(() => "PASS"),
  );
  assert.deepEqual(
    first.steps.map((step) => step.checks),
    second.steps.map((step) => step.checks),
  );
  assert.deepEqual(
    first.steps.map((step) => step.status),
    second.steps.map((step) => step.status),
  );
  assert.match(first.journey_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.integration_note, /No NEAR contract/);
  for (const step of first.steps) {
    assert.equal(step.error, null);
    assert.equal(step.checks.length > 0, true);
  }
});

test("journey and individual track evidence persist with private paths", async () => {
  const dir = await tempDir();
  try {
    const journey = runJourney();
    const journeyFile = await persistJourney(dir, journey);
    assert.equal(path.dirname(journeyFile), path.join(dir, "journeys"));
    const storedJourney = JSON.parse(await fs.readFile(journeyFile, "utf8")) as {
      journey_sha256: string;
      all_passed: boolean;
    };
    assert.equal(storedJourney.all_passed, true);
    assert.equal(storedJourney.journey_sha256, journey.journey_sha256);

    const run = runTrack("security");
    const runFile = await persistTrackRun(dir, run);
    assert.equal(path.dirname(runFile), path.join(dir, "track-runs"));
    assert.match(path.basename(runFile), /^security-track_/);
  } finally {
    await cleanup(dir);
  }
});

test("track configs are thin metadata with explicit live limitations", () => {
  assert.deepEqual(
    TRACK_MODULE_LIST.map((module) => module.id),
    TRACK_IDS,
  );
  for (const module of TRACK_MODULE_LIST) {
    assert.equal(module.evidence, "local-simulation");
    assert.match(module.limitation, /No /);
    assert.ok(["not-configured", "requires-human-approval"].includes(module.live_status));
  }
});
