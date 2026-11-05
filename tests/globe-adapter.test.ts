import assert from "node:assert/strict";
import test from "node:test";
// Frontend projection is intentionally runnable without React, WebGL or a DOM.
// @ts-expect-error frontend is a separately built JavaScript application
import { projectNetwork, diffNetwork, adaptEngineEvent, orbitPositions } from "../frontend/src/lib/network.js";

const snapshot = () => ({
  mode: "SIMULATION",
  task: {
    id: "task_one",
    status: "executing",
    plan: {
      subtasks: [
        { id: "one", title: "One", dependencies: [] },
        { id: "two", title: "Two", dependencies: ["one"] },
      ],
    },
    subtasks: [
      {
        id: "one",
        phase: "running_diy",
        updated_at: "2026-11-03T00:00:00Z",
        active_attempt: 1,
        attempts: [{ attempt: 1 }],
      },
      { id: "two", phase: "pending", active_attempt: 0, attempts: [] },
    ],
  },
  tasks: [{ status: "executing" }],
  receipts: [],
  integrity: { ok: true },
});

test("globe distinguishes ambient particles, workflow connections and assigned active agents", () => {
  const idle = projectNetwork(null);
  assert.equal(idle.nodes.length, 0);
  assert.equal(idle.activeAgents, 0);
  assert.equal(idle.verified, null);
  const s = snapshot();
  const network = projectNetwork(s);
  assert.equal(network.nodes.length, 2);
  assert.equal(network.edges.length, 1);
  assert.equal(network.activeAgents, 0);
  const changed = JSON.parse(JSON.stringify(s));
  changed.task.subtasks[0].attempts[0].vendor = { id: "v1", name: "Vendor" };
  assert.equal(projectNetwork(changed).activeAgents, 0, "vendor selection is not an assignment");
  changed.task.subtasks[0].attempts[0].job_id = "job_confirmed";
  assert.equal(projectNetwork(changed).activeAgents, 1);
  changed.task.status = "paused";
  assert.equal(projectNetwork(changed).activeAgents, 0);
});

test("globe does not replay historical snapshots or invent blockchain confirmations", () => {
  const s = snapshot();
  assert.deepEqual(diffNetwork(null, s), []);
  assert.deepEqual(diffNetwork(s, s), []);
  assert.deepEqual(diffNetwork(s, { ...s, task: { ...s.task, id: "task_other" } }), []);
  assert.equal(
    adaptEngineEvent({ type: "engine", event: { task_id: "task_one", code: "JOB_FUNDED", at: "now" } }, s),
    null,
  );
  const changed = JSON.parse(JSON.stringify(s));
  changed.task.subtasks[0].attempts[0].payment_status = "SIMULATED_RELEASED";
  const events = diffNetwork(s, changed);
  assert.equal(events[0].type, "transaction.confirmed");
  assert.equal(events[0].simulated, true);
  assert.match(events[0].detail, /not a blockchain finality/);
  assert.equal(
    adaptEngineEvent({ type: "engine", event: { task_id: "different", code: "TASK_COMPLETED", at: "now" } }, s),
    null,
  );
});

test("all orbit rings have continuous, non-degenerate edges through their closing seam", () => {
  for (const radius of [2.05, 2.24, 2.35]) {
    const points: Float32Array = orbitPositions(radius);
    const count = points.length / 3;
    const expected = 2 * radius * Math.sin(Math.PI / count);
    const edge = (i: number) => {
      const next = (i + 1) % count;
      return [points[next * 3]! - points[i * 3]!, points[next * 3 + 2]! - points[i * 3 + 2]!];
    };
    for (let i = 0; i < count; i++) {
      assert.ok(Math.abs(Math.hypot(points[i * 3]!, points[i * 3 + 2]!) - radius) < 1e-6);
      const a = edge(i),
        b = edge((i + 1) % count);
      assert.ok(
        Math.abs(Math.hypot(...a) - expected) < 1e-6,
        "closing seam must have the same length as every other edge",
      );
      const turn = Math.acos(Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]!) / (Math.hypot(...a) * Math.hypot(...b))));
      assert.ok(Math.abs(turn - (2 * Math.PI) / count) < 0.0001, "no kink in the ring tangent, including the seam");
    }
  }
});
