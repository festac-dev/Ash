import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDemoTask } from "../src/demo.js";
import { TaskStore } from "../src/state/store.js";
import { startAshServer } from "../src/server/server.js";
import { exportTaskReport } from "../src/report.js";
import { registerSecret, clearRegisteredSecrets } from "../src/util/redact.js";
import { commitEscrow, releaseEscrow } from "../src/ledger/ledger.js";
import { testConfig, tempDir, cleanup } from "./helpers.js";

test("showcase has a real fan-out/join plan and reuses unfinished demo state", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const id = await createDemoTask(config);
    assert.equal(await createDemoTask(config), id);
    const task = await new TaskStore(config).load(id);
    assert.equal(task.status, "planned");
    assert.deepEqual(task.plan?.subtasks[3]?.dependencies, ["st_2", "st_3"]);
    assert.equal(task.plan?.external_planned, "14.00");
    const live = { ...config, simulation: false };
    await assert.rejects(() => createDemoTask(live), /requires simulation/);
  } finally {
    await cleanup(dir);
  }
});

test("proof exports escape HTML and redact credentials in all three formats", async () => {
  const dir = await tempDir();
  try {
    const config = testConfig(dir);
    const id = await createDemoTask(config);
    const store = new TaskStore(config);
    const secret = "private-test-value-0123456789";
    registerSecret(secret);
    const task = await store.load(id);
    task.description = `<script>alert('unsafe')</script> ${secret}`;
    task.additional_instructions = secret;
    const files = await exportTaskReport(store, config, task);
    const html = await readFile(files.htmlPath, "utf8");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /SIMULATION/);
    for (const file of Object.values(files)) assert.equal((await readFile(file, "utf8")).includes(secret), false);
    assert.ok(JSON.parse(await readFile(files.jsonPath, "utf8")).task);
  } finally {
    clearRegisteredSecrets();
    await cleanup(dir);
  }
});

test("authenticated timeline and proof endpoints expose ledger evidence without executing work", async () => {
  const dir = await tempDir();
  const token = "showcase-api-token-0123456789";
  const server = await startAshServer({ config: testConfig(dir), token });
  try {
    const id = await createDemoTask(server.services.config);
    const headers = { Authorization: `Bearer ${token}` };
    const store = server.services.store;
    await store.mutateLedger(id, (ledger) =>
      commitEscrow(ledger, "2.00", "job:test", "Test commitment", null, { job_id: "test" }),
    );
    await store.mutateLedger(id, (ledger) =>
      releaseEscrow(ledger, "2.00", "job:test", "Confirmed completion", null, { job_id: "test" }),
    );
    await store.appendEvent(id, {
      subtask_id: "st_2",
      code: "JOB_FUNDED",
      level: "info",
      message: "Funding confirmed",
    });
    const timelineUrl = `${server.session.url}/api/tasks/${id}/timeline`;
    assert.equal((await fetch(timelineUrl)).status, 401);
    const response = await fetch(timelineUrl, { headers });
    assert.equal(response.status, 200);
    const timeline = (await response.json()) as {
      task_id: string;
      entries: { kind: string; amount: string }[];
      events: { code: string }[];
    };
    assert.equal(timeline.task_id, id);
    assert.deepEqual(
      timeline.entries.slice(-2).map((entry) => entry.kind),
      ["COMMIT", "RELEASE"],
    );
    assert.equal(timeline.entries.at(-1)?.amount, "2.00");
    assert.equal(timeline.events.at(-1)?.code, "JOB_FUNDED");
    const proof = await fetch(`${server.session.url}/api/tasks/${id}/proof`, { method: "POST", headers });
    assert.equal(proof.status, 200);
    const files = (await proof.json()) as { htmlPath: string };
    assert.match(await readFile(files.htmlPath, "utf8"), /ASH \/ PROOF OF WORK/);
    assert.equal((await store.load(id)).status, "planned");
    assert.equal(server.services.engine.isRunning(), false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
