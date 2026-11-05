// A read-only projection of ASH's API. Decorative particles are never entities.
export const ACTIVE_PHASES = new Set([
  "running_diy",
  "discovering",
  "preparing_draft",
  "waiting_job",
  "verifying",
  "awaiting_market_acceptance",
]);
const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);
const assignedJob = (attempt) =>
  Boolean(attempt?.job_id) &&
  attempt.payment_status !== "RECONCILIATION_REQUIRED" &&
  (attempt.hiring_mode !== "board" || Boolean(attempt.assignment_id));
export const EVENT_TYPES = new Set([
  "agent.discovered",
  "agent.assigned",
  "agent.connected",
  "task.started",
  "task.completed",
  "transaction.submitted",
  "transaction.confirmed",
  "verification.passed",
  "verification.failed",
  "execution.failed",
  "agent.communication",
]);

export function positionFor(id) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const y = ((hash % 10000) / 10000) * 1.5 - 0.75;
  const angle = (((hash >>> 8) % 10000) / 10000) * Math.PI * 2;
  const r = Math.sqrt(1 - y * y);
  return [r * Math.cos(angle) * 1.83, y * 1.83, r * Math.sin(angle) * 1.83];
}

export function projectNetwork(snapshot) {
  if (!snapshot)
    return {
      nodes: [],
      edges: [],
      agents: 0,
      activeAgents: 0,
      running: 0,
      verified: null,
      task: null,
      simulated: false,
    };
  const task = snapshot.task;
  const nodes = [];
  const edges = [];
  const agents = new Map();
  const plan = new Map((task?.plan?.subtasks ?? []).map((s) => [s.id, s]));
  for (const state of task?.subtasks ?? []) {
    const subtask = plan.get(state.id);
    const attempt = state.attempts?.find((a) => a.attempt === state.active_attempt);
    const id = `${task.id}:${state.id}`;
    const active = task.status === "executing" && ACTIVE_PHASES.has(state.phase);
    nodes.push({
      id,
      label: subtask?.title ?? state.id,
      kind: "task",
      status: state.phase,
      active,
      taskId: task.id,
      subtaskId: state.id,
      position: positionFor(id),
      verified: attempt?.verification?.passed === true,
      detail: subtask?.description ?? "",
      jobId: attempt?.job_id ?? null,
    });
    for (const dep of subtask?.dependencies ?? [])
      edges.push({ id: `${task.id}:${dep}->${id}`, from: `${task.id}:${dep}`, to: id, kind: "dependency" });
    if (attempt?.vendor?.id) {
      const vendorId = `agent:${attempt.vendor.id}`;
      const prior = agents.get(vendorId);
      const assigned = assignedJob(attempt);
      agents.set(vendorId, {
        id: vendorId,
        label: attempt.vendor.name || attempt.vendor.id,
        kind: "agent",
        status: assigned ? "assigned" : "selected",
        active: (assigned && active) || prior?.active || false,
        taskId: task.id,
        subtaskId: state.id,
        position: positionFor(vendorId),
        detail: assigned ? "Marketplace job recorded by ASH." : "Selected vendor; no marketplace assignment recorded.",
        jobId: attempt.job_id ?? null,
      });
      if (assigned) edges.push({ id: `${vendorId}->${id}`, from: vendorId, to: id, kind: "assignment" });
    }
  }
  nodes.push(...agents.values());
  return {
    nodes,
    edges,
    agents: agents.size,
    activeAgents: [...agents.values()].filter((a) => a.active).length,
    running: (snapshot.tasks ?? []).filter((t) => t.status === "executing").length,
    verified: snapshot.integrity?.ok
      ? (snapshot.receipts ?? []).filter((r) => r.receipt.check_result?.passed).length
      : null,
    task,
    simulated: snapshot.mode === "SIMULATION",
  };
}

// Initial snapshots and task switches establish a baseline, never "live" pulses.
export function diffNetwork(previous, next) {
  if (!previous?.task || !next?.task || previous.task.id !== next.task.id) return [];
  const events = [];
  const old = new Map((previous.task.subtasks ?? []).map((s) => [s.id, s]));
  const add = (type, s, detail) =>
    events.push({
      id: `${next.task.id}:${s.id}:${type}:${s.updated_at}`,
      type,
      nodeId: `${next.task.id}:${s.id}`,
      taskId: next.task.id,
      at: s.updated_at,
      detail,
      simulated: next.mode === "SIMULATION",
    });
  for (const s of next.task.subtasks ?? []) {
    const p = old.get(s.id);
    if (!p) continue;
    const a = s.attempts?.find((a) => a.attempt === s.active_attempt);
    const b = p.attempts?.find((a) => a.attempt === p.active_attempt);
    if (a?.vendor?.id && a.vendor.id !== b?.vendor?.id) add("agent.discovered", s, `Selected ${a.vendor.name}`);
    if (assignedJob(a) && (!assignedJob(b) || a.job_id !== b.job_id))
      add("agent.assigned", s, "Marketplace assignment recorded");
    if (s.phase !== p.phase && ACTIVE_PHASES.has(s.phase) && next.task.status === "executing")
      add("task.started", s, "Execution state updated");
    if (s.phase === "completed" && p.phase !== s.phase) add("task.completed", s, "Subtask completed");
    if (a?.verification?.checked_at && a.verification.checked_at !== b?.verification?.checked_at) {
      if (a.verification.passed) add("verification.passed", s, "Acceptance checks passed");
      else if (a.verification.status === "failed") add("verification.failed", s, "Acceptance checks failed");
    }
    if (a?.payment_status !== b?.payment_status && ["RELEASED", "SIMULATED_RELEASED"].includes(a?.payment_status)) {
      add("transaction.confirmed", s, "Marketplace settlement recorded; not a blockchain finality assertion");
    }
  }
  return events;
}

export function adaptEngineEvent(packet, snapshot) {
  const event = packet?.type === "engine" ? packet.event : null;
  if (!snapshot?.task || !event || event.task_id !== snapshot.task.id || !event.at || !event.code) return null;
  const map = {
    JOB_IN_PROGRESS: "task.started",
    DELIVERABLE_RECEIVED: "agent.communication",
    DIY_DELIVERABLE: "task.started",
    TASK_COMPLETED: "task.completed",
    SUBTASK_ERROR: "execution.failed",
    VERIFIER_ERROR: "execution.failed",
    TASK_FAILED: "execution.failed",
  };
  const type = map[event.code];
  if (!type) return null;
  return {
    id: `${event.task_id}:${event.subtask_id}:${event.code}:${event.at}`,
    type,
    nodeId: event.subtask_id ? `${event.task_id}:${event.subtask_id}` : null,
    taskId: event.task_id,
    at: event.at,
    detail: event.message,
    simulated: snapshot.mode === "SIMULATION",
  };
}

export function nodeTone(node) {
  if (["failed", "blocked", "cancelled"].includes(node.status)) return "warning";
  if (node.verified || node.status === "completed") return "verified";
  return node.active ? "active" : "idle";
}

export function describeStatus(value) {
  return String(value ?? "Not connected").replaceAll("_", " ");
}

// lineLoop closes the last edge itself; a duplicate endpoint creates a degenerate seam.
export function orbitPositions(radius, segments = 360) {
  const points = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.set([Math.cos(angle) * radius, 0, Math.sin(angle) * radius], i * 3);
  }
  return points;
}
