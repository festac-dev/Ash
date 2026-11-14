const views = new Set(["dashboard", "tasks", "execution", "market", "transactions", "security", "settings"]);
const locationView = () =>
  typeof location !== "undefined" && views.has(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard";
const initialState = () => ({
  view: locationView(),
  snapshot: null,
  tasks: [],
  market: null,
  agents: null,
  jobs: null,
  agentQuery: "",
  transactions: null,
  security: null,
  settings: null,
  connected: false,
  sse: null,
  busy: false,
});
const state = initialState();
let controlsRoot = null;
let lifecycle = new AbortController();
let embedded = null;
const $ = (selector, root = controlsRoot) => root.querySelector(selector);
let loginScreen,
  appScreen,
  loginForm,
  loginError,
  loginButton,
  accessToken,
  nav,
  viewRoot,
  connectionPill,
  modePill,
  enginePill,
  footerMeta,
  detailDialog,
  dialogTitle,
  dialogBody,
  toastNode;
let toastTimer = null;
let refreshTimer = null;
let pollTimer = null;
let snapshotSequence = 0;
let sessionGeneration = 0;
let fieldSequence = 0;
const auxiliarySequence = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (node.classList.contains("field")) {
    const label = node.querySelector("label");
    const input = node.querySelector("input,textarea,select");
    if (label && input) {
      input.id ||= `field-${++fieldSequence}`;
      label.htmlFor = input.id;
    }
  }
  return node;
}

function button(label, onClick, className = "") {
  const node = el("button", { type: "button", class: className }, label);
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function pill(text, tone = "") {
  return el("span", { class: `pill ${tone}`.trim() }, text);
}

function card(title, ...children) {
  const node = el("section", { class: "panel" });
  if (title) node.append(el("h2", {}, title));
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function statCard(label, value, tone = "") {
  return el(
    "div",
    { class: "panel stat" },
    el("span", { class: "stat-label" }, label),
    el("span", { class: `stat-value ${tone}`.trim() }, value),
  );
}

function metric(label, value) {
  return el("div", { class: "metric-row" }, el("span", {}, label), el("span", { class: "mono" }, value ?? "—"));
}

function empty(message) {
  return el("div", { class: "empty" }, message);
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function shortHash(value) {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function toneForStatus(status) {
  switch (status?.toLowerCase()) {
    case "completed":
    case "passed":
    case "paid":
    case "released":
    case "ok":
    case "connected":
      return "ok";
    case "failed":
    case "cancelled":
    case "blocked":
    case "error":
      return "bad";
    case "executing":
    case "running":
    case "awaiting_plan_approval":
    case "awaiting_human_review":
    case "pending":
    case "escrowed":
      return "warn";
    default:
      return "info";
  }
}

function progress(value, total) {
  const current = Number(value) || 0;
  const max = Number(total) || 0;
  const percent = max > 0 ? Math.min(100, Math.max(0, Math.round((current / max) * 100))) : 0;
  return el(
    "div",
    {},
    el("progress", { class: "bar", max: "100", value: String(percent), "aria-label": `${percent}% complete` }),
    el("div", { class: "progress-label" }, el("span", {}, `${current} / ${max}`), el("span", {}, `${percent}%`)),
  );
}

function viewHead(title, subtitle, actions = []) {
  return el(
    "div",
    { class: "view-head" },
    el("div", {}, el("h1", {}, title), subtitle ? el("p", {}, subtitle) : null),
    actions.length ? el("div", { class: "button-row" }, ...actions) : null,
  );
}

function toast(message, kind = "info") {
  if (lifecycle.signal.aborted) return;
  toastNode.textContent = message;
  toastNode.className = `toast ${kind} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.classList.remove("visible");
  }, 5000);
}

async function request(path, options = {}) {
  const signal = lifecycle.signal;
  signal.throwIfAborted();
  const method = options.method ?? "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") headers["X-Ash-Client"] = "web";
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
    ...options,
    method,
    headers,
    body,
  });
  const text = await response.text();
  signal.throwIfAborted();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      showLogin("Your session expired. Sign in again.");
    }
    const error = new Error(payload?.error?.message || payload?.raw || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function setBusy(value) {
  state.busy = value;
  (controlsRoot.host || document.body).classList.toggle("busy", value);
}

async function runAction(label, action) {
  if (state.busy) return;
  const owner = lifecycle;
  setBusy(true);
  try {
    await action();
    toast(`${label} complete`, "success");
    await refreshAll(true, true);
  } catch (error) {
    if (owner === lifecycle && error.name !== "AbortError" && error.status !== 401)
      toast(`${label}: ${error.message}`, "error");
  } finally {
    if (owner === lifecycle && !owner.signal.aborted) setBusy(false);
  }
}

function showLogin(message = "") {
  sessionGeneration++;
  snapshotSequence++;
  closeDialog();
  clearTimeout(refreshTimer);
  clearInterval(pollTimer);
  setBusy(false);
  state.view = embedded ? state.view : locationView();
  if (state.sse) state.sse.close();
  state.sse = null;
  state.snapshot = null;
  state.tasks = [];
  state.market = state.agents = state.jobs = state.transactions = state.security = state.settings = null;
  viewRoot.replaceChildren();
  state.connected = false;
  if (embedded) {
    embedded.onUnauthorized();
    return;
  }
  appScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginError.textContent = message;
  loginButton.disabled = false;
  setTimeout(() => accessToken.focus(), 30);
}

async function enterApp() {
  const owner = lifecycle;
  loginScreen?.classList.add("hidden");
  appScreen?.classList.remove("hidden");
  renderNav();
  await refreshAll(true, false);
  if (owner !== lifecycle || owner.signal.aborted || !state.snapshot) return;
  await loadAuxData(state.view);
  renderView(true);
  if (owner === lifecycle && !owner.signal.aborted && state.snapshot) startEvents();
}

async function loginWith(credentials) {
  loginButton.disabled = true;
  loginError.textContent = "";
  try {
    await request("/api/auth/login", { method: "POST", body: credentials });
    accessToken.value = "";
    await enterApp();
  } finally {
    loginButton.disabled = false;
  }
}

async function bootstrap() {
  try {
    const session = await request("/api/auth/session");
    if (session.authenticated) await enterApp();
    else showLogin("");
  } catch (error) {
    if (error.name !== "AbortError") showLogin(`Cannot reach Ash: ${error.message}`);
  }
}

function updateChrome() {
  if (embedded) return;
  const snapshot = state.snapshot;
  const mode = snapshot?.mode ?? "UNKNOWN";
  const engine = snapshot?.engine_running ? "engine running" : "engine idle";
  connectionPill.textContent = state.connected ? "live updates" : "reconnecting";
  connectionPill.className = `pill ${state.connected ? "connected" : "warn"}`;
  modePill.textContent = mode;
  modePill.className = `pill ${mode === "SIMULATION" ? "violet" : "ok"}`;
  enginePill.textContent = engine;
  enginePill.className = `pill ${snapshot?.engine_running ? "ok" : ""}`;
  if (!snapshot) {
    footerMeta.textContent = "not connected";
    return;
  }
  footerMeta.textContent = `Ash ${snapshot.server.version} · ${snapshot.tasks.length} tasks`;
}

function renderNav() {
  for (const item of nav?.querySelectorAll("button[data-view]") ?? []) {
    item.classList.toggle("active", item.dataset.view === state.view);
    if (item.dataset.view === state.view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

async function refreshSnapshot() {
  const sequence = ++snapshotSequence;
  const snapshot = await request("/api/state");
  if (sequence !== snapshotSequence) return;
  if (snapshot.active_task_id !== state.snapshot?.active_task_id) state.security = state.settings = null;
  state.snapshot = snapshot;
  state.tasks = state.snapshot.tasks ?? [];
  updateChrome();
}

async function loadAuxData(view) {
  const generation = sessionGeneration;
  const taskId = state.snapshot?.active_task_id;
  const sequence = (auxiliarySequence.get(view) ?? 0) + 1;
  auxiliarySequence.set(view, sequence);
  const current = () =>
    generation === sessionGeneration &&
    sequence === auxiliarySequence.get(view) &&
    taskId === state.snapshot?.active_task_id;
  const failure = (error, fallback) => {
    if (error.status === 401) throw error;
    return fallback;
  };
  if (view === "market") {
    const [market, agents, jobs] = await Promise.all([
      request("/api/market").catch((error) =>
        failure(error, { connected: false, error: error.message, balance: {}, tools: [] }),
      ),
      request(`/api/agents?query=${encodeURIComponent(state.agentQuery)}`).catch((error) =>
        failure(error, { agents: [] }),
      ),
      request("/api/jobs").catch((error) => failure(error, { jobs: [] })),
    ]);
    if (!current()) return;
    state.market = market;
    state.agents = Array.isArray(agents?.agents) ? agents.agents : [];
    state.jobs = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  } else if (view === "transactions") {
    const data = await request("/api/transactions?limit=100");
    if (current()) state.transactions = data;
  } else if (view === "security") {
    const data = await request("/api/security");
    if (current()) state.security = data;
  } else if (view === "settings") {
    const data = await request("/api/settings");
    if (current()) state.settings = data;
  }
}

async function refreshAll(force = false, withAux = false) {
  try {
    await refreshSnapshot();
    if (withAux) await loadAuxData(state.view);
    renderView(force);
  } catch (error) {
    if (error.name !== "AbortError" && error.status !== 401) toast(`Refresh failed: ${error.message}`, "error");
  }
}

async function switchView(view, fromHistory = false) {
  const owner = lifecycle;
  if (!views.has(view) || state.view === view) return;
  if (embedded) embedded.onNavigate(view);
  else if (!fromHistory) history.pushState(null, "", `#${view}`);
  if (appScreen?.classList.contains("hidden")) {
    state.view = view;
    return;
  }
  state.view = view;
  renderNav();
  viewRoot.replaceChildren(el("div", { class: "empty" }, "Loading…"));
  try {
    await refreshSnapshot();
    await loadAuxData(view);
    if (owner === lifecycle && !owner.signal.aborted) renderView(true);
  } catch (error) {
    if (owner === lifecycle && error.name !== "AbortError" && error.status !== 401)
      viewRoot.replaceChildren(empty(`Could not load ${view}: ${error.message}`));
  }
}

function isTypingInForm() {
  const active = controlsRoot.activeElement || document.activeElement;
  return Boolean(active && active.closest("form") && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

function renderView(force = false) {
  if (lifecycle.signal.aborted || !state.snapshot) return;
  if (!force && (isTypingInForm() || viewRoot.querySelector("form[data-dirty='true']"))) return;
  let node;
  switch (state.view) {
    case "tasks":
      node = renderTasks();
      break;
    case "execution":
      node = renderExecution();
      break;
    case "market":
      node = renderMarket();
      break;
    case "transactions":
      node = renderTransactions();
      break;
    case "security":
      node = renderSecurity();
      break;
    case "settings":
      node = renderSettings();
      break;
    default:
      node = renderDashboard();
  }
  viewRoot.replaceChildren(node);
}

function scheduleRefresh(delay = 400) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!state.snapshot || !state.sse || document.hidden) return;
    refreshAll(false, false).catch(() => undefined);
  }, delay);
}

function startEvents() {
  if (state.sse) state.sse.close();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (state.snapshot && !document.hidden) refreshAll(false, false).catch(() => undefined);
  }, 15_000);
  const source = new EventSource("/api/events");
  state.sse = source;
  source.addEventListener("open", () => {
    state.connected = true;
    updateChrome();
    scheduleRefresh(100);
  });
  source.addEventListener("error", () => {
    state.connected = false;
    updateChrome();
  });
  for (const name of ["engine", "refresh", "server"]) {
    source.addEventListener(name, () => scheduleRefresh(250));
  }
}

function openDialog(title, nodes) {
  dialogTitle.textContent = title;
  dialogBody.replaceChildren(...nodes);
  if (!detailDialog.open) detailDialog.showModal();
}

function closeDialog() {
  if (detailDialog.open) detailDialog.close();
  dialogBody.replaceChildren();
}

function askPhrase({ title, description, expected, confirmLabel, tone = "primary", onSubmit }) {
  const input = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: expected,
    "aria-label": "Confirmation phrase",
  });
  const error = el("p", { class: "error", role: "alert" });
  const submit = el("button", { type: "submit", class: tone }, confirmLabel);
  const cancel = button("Cancel", closeDialog, "ghost");
  const form = el(
    "form",
    {},
    el("p", { class: "task-detail" }, description),
    el("p", { class: "phrase-hint" }, `Type exactly: ${expected}`),
    el("div", { class: "field" }, el("label", {}, "Confirmation phrase"), input),
    el("div", { class: "button-row" }, submit, cancel),
    error,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (input.value.trim() !== expected) {
      error.textContent = `Type exactly: ${expected}`;
      input.focus();
      return;
    }
    submit.disabled = true;
    error.textContent = "";
    try {
      await onSubmit(input.value.trim());
      closeDialog();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });
  openDialog(title, [form]);
  setTimeout(() => input.focus(), 30);
}

async function requestBudget(taskId) {
  const amount = el("input", { type: "text", inputmode: "decimal", placeholder: "175.00", required: true });
  const error = el("p", { class: "error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary" }, "Request approval");
  const cancel = button("Cancel", closeDialog, "ghost");
  const form = el(
    "form",
    {},
    el("p", { class: "task-detail" }, "Budget changes require approval."),
    el("div", { class: "field" }, el("label", {}, "New authorized budget"), amount),
    el("div", { class: "button-row" }, submit, cancel),
    error,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "";
    try {
      const result = await request(`/api/tasks/${encodeURIComponent(taskId)}/budget`, {
        method: "POST",
        body: { amount: amount.value.trim() },
      });
      closeDialog();
      toast(`Budget approval ${result.approval.id} requested. Approve it in Security.`, "warn");
      await refreshAll(true, true);
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });
  openDialog("Request a budget change", [form]);
  setTimeout(() => amount.focus(), 30);
}

function approvalsPanel(approvals) {
  if (!approvals.length) return empty("No pending approvals.");
  return el(
    "div",
    { class: "list" },
    ...approvals.map((approval) => {
      const summary = el("p", {}, approval.summary);
      const meta = el(
        "div",
        { class: "task-line" },
        pill(approval.kind, "warn"),
        approval.amount ? el("span", { class: "mono" }, `${approval.amount} ${approval.currency}`) : null,
        el("span", { class: "muted small" }, `expires ${fmtDate(approval.expires_at)}`),
      );
      return el(
        "article",
        { class: "list-item approval" },
        el("div", { class: "list-item-head" }, summary, meta),
        el("p", { class: "phrase-hint" }, `Approve: APPROVE ${approval.id} · Deny: DENY ${approval.id}`),
        el(
          "div",
          { class: "button-row" },
          button("Approve", () => askApproval(approval, "approve"), "primary"),
          button("Deny", () => askApproval(approval, "deny"), "danger"),
        ),
      );
    }),
  );
}

function askApproval(approval, decision) {
  const action = decision === "approve" ? "APPROVE" : "DENY";
  askPhrase({
    title: `${action === "APPROVE" ? "Approve" : "Deny"} ${approval.kind}`,
    description: approval.summary,
    expected: `${action} ${approval.id}`,
    confirmLabel: action === "APPROVE" ? "Approve with phrase" : "Deny with phrase",
    tone: action === "APPROVE" ? "primary" : "danger",
    onSubmit: async () => {
      await request(`/api/tasks/${encodeURIComponent(approval.task_id)}/${decision}`, {
        method: "POST",
        body: { approval_id: approval.id, phrase: `${action} ${approval.id}` },
      });
      toast(`Approval ${action.toLowerCase()}d.`, action === "APPROVE" ? "success" : "warn");
      await refreshAll(true, true);
    },
  });
}

function eventsPanel(events, limit = 12) {
  const items = (events ?? []).slice(-limit).reverse();
  if (!items.length) return empty("No events yet.");
  return el(
    "div",
    {},
    ...items.map((event) =>
      el(
        "div",
        { class: `event level-${event.level}` },
        el("time", { datetime: event.at }, fmtDate(event.at)),
        el(
          "div",
          {},
          el("span", { class: "code" }, event.code),
          el("span", { class: "muted" }, " · "),
          el("span", { class: "message" }, event.message),
        ),
      ),
    ),
  );
}

function receiptsPanel(receipts, limit = 6) {
  const items = (receipts ?? []).slice(0, limit);
  if (!items.length) return empty("No receipts recorded yet.");
  return el(
    "div",
    { class: "list" },
    ...items.map((entry) => {
      const receipt = entry.receipt;
      return el(
        "article",
        { class: "list-item" },
        el(
          "div",
          { class: "list-item-head" },
          el("div", {}, el("strong", {}, receipt.item), el("div", { class: "muted small" }, entry.file)),
          el(
            "div",
            { class: "task-line" },
            pill(receipt.status, toneForStatus(receipt.status)),
            pill(receipt.payment_status, toneForStatus(receipt.payment_status)),
          ),
        ),
        el(
          "div",
          { class: "task-line" },
          el("span", { class: "muted" }, `${receipt.agreed_price ?? receipt.planned_max} ${receipt.currency}`),
          el("span", { class: "hash" }, shortHash(receipt.hash)),
        ),
        el(
          "div",
          { class: "button-row" },
          button("Inspect receipt", () => inspectReceipt(entry.file), "cyan"),
        ),
      );
    }),
  );
}

async function inspectReceipt(file) {
  try {
    const result = await request(`/api/receipts/${encodeURIComponent(file)}`);
    openDialog(`Receipt ${file}`, [el("pre", { class: "json", text: JSON.stringify(result.receipt, null, 2) })]);
  } catch (error) {
    toast(`Receipt: ${error.message}`, "error");
  }
}

function budgetPanel(ledger) {
  if (!ledger) return empty("No budget yet.");
  const authorized = Number(ledger.authorized) || 0;
  const available = Number(ledger.available) || 0;
  const used = Math.max(0, authorized - available);
  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "grid two" },
      statCard("Authorized", `${ledger.authorized} ${ledger.currency}`, "cyan"),
      statCard("Available", `${ledger.available} ${ledger.currency}`, "green"),
      statCard("Committed", `${ledger.committed} ${ledger.currency}`, "amber"),
      statCard("Paid", `${ledger.paid} ${ledger.currency}`),
    ),
    progress(used, authorized),
  );
}

function renderDashboard() {
  const snapshot = state.snapshot;
  const task = snapshot.task;
  const integrity = snapshot.integrity;
  const market = snapshot.market ?? {};
  const approvals = snapshot.approvals ?? [];
  const events = snapshot.events ?? [];
  const receipts = snapshot.receipts ?? [];
  const marketTone = market.connected ? "ok" : market.mode === "simulated" ? "violet" : "bad";
  const integrityTone = integrity?.ok ? "ok" : "bad";
  const taskProgress = task
    ? progress(task.subtasks.filter((item) => item.phase === "completed").length, task.plan?.subtasks.length ?? 0)
    : empty("No active task.");
  return el(
    "div",
    { class: "stack" },
    viewHead("Command centre", "", [
      button("New task", () => switchView("tasks"), "primary"),
      button("Refresh", () => refreshAll(true, true), "ghost"),
    ]),
    el(
      "div",
      { class: "grid four" },
      statCard("Mode", snapshot.mode, snapshot.mode === "SIMULATION" ? "violet" : "green"),
      statCard(
        "Marketplace",
        market.connected ? "connected" : market.mode === "simulated" ? "simulated" : "offline",
        marketTone,
      ),
      statCard("Receipt chain", integrity?.ok ? "verified" : "needs attention", integrityTone),
      statCard("Pending approvals", String(approvals.length), approvals.length ? "amber" : ""),
    ),
    el(
      "div",
      { class: "split" },
      el(
        "div",
        { class: "stack" },
        card(
          "Current task",
          task
            ? el(
                "div",
                { class: "stack" },
                el(
                  "div",
                  { class: "task-line" },
                  pill(task.status, toneForStatus(task.status)),
                  pill(task.currency, "info"),
                  el("span", { class: "mono" }, `${task.authorized_budget} ${task.currency}`),
                ),
                el("p", { class: "task-description" }, task.description),
                task.status_detail ? el("p", { class: "task-detail" }, task.status_detail) : null,
                taskProgress,
                task.plan
                  ? el("p", { class: "task-detail" }, task.plan.summary)
                  : el("p", { class: "muted" }, "No plan yet."),
                el(
                  "div",
                  { class: "button-row" },
                  button("Open task controls", () => switchView("tasks"), "primary"),
                  button("View live execution", () => switchView("execution"), "cyan"),
                  task.id ? button("Request budget change", () => requestBudget(task.id), "warn") : null,
                ),
              )
            : empty("No active task."),
        ),
        card("Budget", budgetPanel(snapshot.ledger)),
        card("Pending human gates", approvalsPanel(approvals)),
        card("Recent activity", eventsPanel(events)),
      ),
      el(
        "div",
        { class: "stack" },
        card(
          "System",
          el(
            "div",
            { class: "metric-list" },
            metric("Server", `${snapshot.server.version} · pid ${snapshot.server.pid}`),
            metric("Started", fmtDate(snapshot.server.started_at)),
            metric("Engine", snapshot.engine_running ? "running" : "idle"),
            metric("Web UI", snapshot.config?.server?.ui ? "enabled" : "disabled"),
            metric("Marketplace mode", market.mode ?? "—"),
            metric("Market error", market.error ?? "none"),
          ),
        ),
        card(
          "Receipt integrity",
          integrity
            ? el(
                "div",
                { class: "metric-list" },
                metric("Status", integrity.ok ? "verified" : "broken"),
                metric("Receipts", String(integrity.receipt_count ?? 0)),
                metric("Last file", integrity.last_file ?? "—"),
                metric("Last hash", shortHash(integrity.last_hash)),
              )
            : empty("Integrity unavailable."),
        ),
        card("Recent receipts", receiptsPanel(receipts)),
      ),
    ),
  );
}

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function taskForm() {
  const description = el("textarea", {
    name: "description",
    required: true,
    maxlength: "10000",
    placeholder: "Describe the outcome you need, not just the steps.",
  });
  const budget = el("input", { name: "budget", required: true, inputmode: "decimal", placeholder: "150.00" });
  const currency = el(
    "select",
    { name: "currency" },
    el("option", { value: "USDC" }, "USDC"),
    el("option", { value: "USD" }, "USD"),
  );
  const strategy = el(
    "select",
    { name: "execution_strategy" },
    el("option", { value: "plan_then_approve" }, "Plan first, then request approval"),
    el("option", { value: "autonomous" }, "Autonomous within approved limits"),
    el("option", { value: "diy_first" }, "Do it locally unless external expertise is needed"),
  );
  const maximumParallel = state.snapshot?.config?.max_parallel_jobs ?? 1;
  const parallel = el("input", {
    name: "max_parallel_jobs",
    type: "number",
    min: "1",
    max: String(maximumParallel),
    value: String(maximumParallel),
  });
  const deadline = el("input", { name: "deadline", type: "datetime-local" });
  const quality = el("textarea", {
    name: "quality_requirements",
    maxlength: "4000",
    placeholder: "Measurable quality bar, tests or evidence required.",
  });
  const agents = el("input", { name: "preferred_agents", placeholder: "agent-handle, another-agent" });
  const instructions = el("textarea", {
    name: "additional_instructions",
    maxlength: "4000",
    placeholder: "Constraints, exclusions or context.",
  });
  const allowExternal = el("input", { type: "checkbox", name: "allow_external", checked: true });
  const diyFirst = el("input", { type: "checkbox", name: "diy_first", checked: true });
  const requireApproval = el("input", { type: "checkbox", name: "require_hiring_approval", checked: true });
  const form = el(
    "form",
    { "aria-label": "Create a task" },
    el("div", { class: "field full" }, el("label", {}, "Task description"), description),
    el(
      "div",
      { class: "form-grid" },
      el("div", { class: "field" }, el("label", {}, "Maximum budget"), budget),
      el("div", { class: "field" }, el("label", {}, "Currency"), currency),
      el("div", { class: "field" }, el("label", {}, "Execution strategy"), strategy),
      el("div", { class: "field" }, el("label", {}, "Maximum parallel jobs"), parallel),
      el("div", { class: "field" }, el("label", {}, "Deadline (optional)"), deadline),
      el("div", { class: "field" }, el("label", {}, "Preferred agents (optional)"), agents),
    ),
    el("div", { class: "field full" }, el("label", {}, "Quality requirements (optional)"), quality),
    el("div", { class: "field full" }, el("label", {}, "Additional instructions (optional)"), instructions),
    el(
      "div",
      { class: "button-row" },
      el("label", { class: "check" }, allowExternal, "External agents allowed"),
      el("label", { class: "check" }, diyFirst, "Try local work first"),
      el("label", { class: "check" }, requireApproval, "Require approval before hiring"),
    ),
    el("div", { class: "button-row" }, el("button", { type: "submit", class: "primary" }, "Create task")),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      description: description.value.trim(),
      budget: budget.value.trim(),
      currency: currency.value,
      execution_strategy: strategy.value,
      max_parallel_jobs: Number(parallel.value),
      deadline: deadline.value ? new Date(deadline.value).toISOString() : null,
      quality_requirements: quality.value.trim() || null,
      preferred_agents: agents.value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      additional_instructions: instructions.value.trim() || null,
      allow_external: allowExternal.checked,
      diy_first: diyFirst.checked,
      require_hiring_approval: requireApproval.checked,
    };
    await runAction("Create task", async () => {
      const created = await request("/api/tasks", { method: "POST", body: payload });
      form.reset();
      delete form.dataset.dirty;
      form.querySelector("button[type=submit]").disabled = true;
      toast(`Task ${created.task.id} created. Plan it next.`, "success");
    });
  });
  return form;
}

function taskCard(task) {
  const completed = task.completed_subtasks ?? 0;
  const planned = task.plan_subtasks ?? 0;
  const isActive = state.snapshot?.active_task_id === task.id;
  return el(
    "article",
    { class: "list-item" },
    el(
      "div",
      { class: "list-item-head" },
      el(
        "div",
        {},
        el(
          "div",
          { class: "task-line" },
          isActive ? pill("active", "ok") : null,
          pill(task.status, toneForStatus(task.status)),
          pill(task.project ?? "custom", "info"),
        ),
        el("p", { class: "task-description" }, task.description),
        el(
          "p",
          { class: "muted small" },
          `${task.budget} ${task.currency} · ${planned} planned · ${completed} complete · updated ${fmtDate(task.updated_at)}`,
        ),
      ),
      el(
        "div",
        { class: "button-row" },
        button("Open", () => openTask(task.id), "cyan"),
      ),
    ),
    planned ? progress(completed, planned) : null,
    el(
      "div",
      { class: "button-row" },
      !isActive
        ? button(
            "Activate",
            () =>
              runAction("Activate task", async () =>
                request(`/api/tasks/${encodeURIComponent(task.id)}/activate`, { method: "POST", body: {} }),
              ),
            "ghost",
          )
        : null,
      button("Plan", () => planTask(task.id), "primary"),
      task.status === "executing"
        ? button(
            "Pause",
            () =>
              runAction("Pause execution", async () =>
                request(`/api/tasks/${encodeURIComponent(task.id)}/pause`, { method: "POST", body: {} }),
              ),
            "warn",
          )
        : null,
      task.status === "paused"
        ? button(
            "Resume",
            () =>
              runAction("Resume execution", async () =>
                request(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { method: "POST", body: {} }),
              ),
            "primary",
          )
        : null,
      ["planned", "paused"].includes(task.status)
        ? button(
            "Execute",
            () =>
              runAction("Start execution", async () =>
                request(`/api/tasks/${encodeURIComponent(task.id)}/execute`, { method: "POST", body: {} }),
              ),
            "primary",
          )
        : null,
      button("Cancel", () => cancelTask(task), "danger"),
    ),
  );
}

async function openTask(taskId) {
  let task = state.snapshot?.task?.id === taskId ? state.snapshot.task : null;
  if (!task) {
    try {
      task = (await request(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
    } catch (error) {
      toast(`Task: ${error.message}`, "error");
      return;
    }
  }
  if (!task) return;
  const details = [];
  if (task.plan) {
    details.push(el("p", { class: "task-detail" }, task.plan.summary));
    details.push(el("p", {}, task.plan.final_outcome));
    details.push(
      el(
        "div",
        { class: "metric-list" },
        metric("External planned", `${task.plan.external_planned} ${task.plan.currency}`),
        metric("Reserve", `${task.plan.contingency} ${task.plan.currency}`),
        metric("Plan approved", task.plan_approved_at ? fmtDate(task.plan_approved_at) : "not yet"),
      ),
    );
    details.push(planTable(task));
  }
  openDialog(task.description, details.length ? details : [empty("No plan installed yet.")]);
}

function planTable(task) {
  const plan = task.plan;
  if (!plan) return empty("No plan.");
  return el(
    "div",
    { class: "table-wrap", role: "region", "aria-label": "Task plan", tabindex: "0" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["ID", "Subtask", "Mode", "Dependencies", "Max", "Acceptance"].map((label) => el("th", {}, label)),
        ),
      ),
      el(
        "tbody",
        {},
        ...plan.subtasks.map((subtask) =>
          el(
            "tr",
            {},
            el("td", { class: "mono" }, subtask.id),
            el("td", {}, el("strong", {}, subtask.title), el("div", { class: "muted small" }, subtask.deliverable)),
            el("td", {}, pill(subtask.execution, subtask.execution === "DIY" ? "ok" : "violet")),
            el("td", { class: "mono" }, subtask.dependencies.length ? subtask.dependencies.join(", ") : "—"),
            el("td", { class: "mono" }, `${subtask.planned_max} ${plan.currency}`),
            el("td", {}, subtask.acceptance_criteria.map((criterion) => criterion.kind).join(", ")),
          ),
        ),
      ),
    ),
  );
}

async function planTask(taskId) {
  await runAction("Plan task", async () => {
    const result = await request(`/api/tasks/${encodeURIComponent(taskId)}/plan`, { method: "POST", body: {} });
    toast(
      result.approval
        ? `Plan created. Approval ${result.approval.id} is waiting in Security.`
        : "Plan created and accepted by the autonomous strategy.",
      result.approval ? "warn" : "success",
    );
  });
}

async function cancelTask(task) {
  askPhrase({
    title: "Cancel task",
    description: "Stops new work. Existing marketplace escrow is not cancelled or refunded.",
    expected: `CANCEL ${task.id}`,
    confirmLabel: "Cancel task",
    tone: "danger",
    onSubmit: async () => {
      await request(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
        method: "POST",
        body: { phrase: `CANCEL ${task.id}` },
      });
      toast("Task cancelled.", "warn");
      await refreshAll(true, true);
    },
  });
}

function renderTasks() {
  const snapshot = state.snapshot;
  const tasks = state.tasks ?? [];
  const active = snapshot.task;
  return el(
    "div",
    { class: "stack" },
    viewHead("Tasks", ""),
    el(
      "div",
      { class: "split" },
      el(
        "div",
        { class: "stack" },
        card("Create a task", taskForm()),
        card(
          "Task sessions",
          tasks.length ? el("div", { class: "list" }, ...tasks.map(taskCard)) : empty("No tasks yet."),
        ),
      ),
      el(
        "div",
        { class: "stack" },
        card(
          "Active plan",
          active
            ? el(
                "div",
                { class: "stack" },
                el(
                  "div",
                  { class: "task-line" },
                  pill(active.status, toneForStatus(active.status)),
                  pill(active.currency, "info"),
                ),
                el("p", { class: "task-description" }, active.description),
                active.plan ? planTable(active) : empty("No plan yet."),
                active.id ? button("Request budget change", () => requestBudget(active.id), "warn") : null,
              )
            : empty("No active task."),
        ),
      ),
    ),
  );
}

function taskActionButtons(task) {
  const isActive = state.snapshot?.active_task_id === task.id;
  const actions = [];
  if (!isActive) {
    actions.push(
      button(
        "Activate",
        () =>
          runAction("Activate task", async () =>
            request(`/api/tasks/${encodeURIComponent(task.id)}/activate`, { method: "POST", body: {} }),
          ),
        "ghost",
      ),
    );
  }
  actions.push(button("Plan", () => planTask(task.id), "primary"));
  if (task.status === "executing") {
    actions.push(
      button(
        "Pause",
        () =>
          runAction("Pause execution", async () =>
            request(`/api/tasks/${encodeURIComponent(task.id)}/pause`, { method: "POST", body: {} }),
          ),
        "warn",
      ),
    );
  }
  if (task.status === "paused") {
    actions.push(
      button(
        "Resume",
        () =>
          runAction("Resume execution", async () =>
            request(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { method: "POST", body: {} }),
          ),
        "primary",
      ),
    );
  }
  if (["planned", "paused"].includes(task.status)) {
    actions.push(
      button(
        "Execute",
        () =>
          runAction("Start execution", async () =>
            request(`/api/tasks/${encodeURIComponent(task.id)}/execute`, { method: "POST", body: {} }),
          ),
        "primary",
      ),
    );
  }
  actions.push(button("Cancel", () => cancelTask(task), "danger"));
  return actions;
}

function subtaskTable(task) {
  if (!task.plan) return empty("No plan installed.");
  return el(
    "div",
    { class: "table-wrap", role: "region", "aria-label": "Subtask progress", tabindex: "0" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["ID", "Subtask", "Mode", "Phase", "Dependencies", "Max", "Attempt"].map((label) => el("th", {}, label)),
        ),
      ),
      el(
        "tbody",
        {},
        ...task.plan.subtasks.map((subtask) => {
          const current = task.subtasks.find((item) => item.id === subtask.id);
          return el(
            "tr",
            {},
            el("td", { class: "mono" }, subtask.id),
            el("td", {}, el("strong", {}, subtask.title), el("div", { class: "muted small" }, subtask.deliverable)),
            el("td", {}, pill(subtask.execution, subtask.execution === "DIY" ? "ok" : "violet")),
            el("td", {}, pill(current?.phase ?? "pending", toneForStatus(current?.phase))),
            el("td", { class: "mono" }, subtask.dependencies.length ? subtask.dependencies.join(", ") : "—"),
            el("td", { class: "mono" }, `${subtask.planned_max} ${task.plan.currency}`),
            el("td", { class: "mono" }, String(current?.attempts.length ?? 0)),
          );
        }),
      ),
    ),
  );
}

function attemptsPanel(task) {
  const rows = [];
  for (const subtask of task.plan?.subtasks ?? []) {
    const current = task.subtasks.find((item) => item.id === subtask.id);
    for (const attempt of current?.attempts ?? []) {
      rows.push(
        el(
          "article",
          { class: "list-item" },
          el(
            "div",
            { class: "list-item-head" },
            el(
              "div",
              {},
              el("strong", {}, `${subtask.id} · attempt ${attempt.attempt}`),
              el(
                "div",
                { class: "muted small" },
                `${attempt.kind} · ${attempt.status} · started ${fmtDate(attempt.started_at)}`,
              ),
            ),
            el(
              "div",
              { class: "task-line" },
              attempt.verification
                ? pill(attempt.verification.status, toneForStatus(attempt.verification.status))
                : null,
              attempt.payment_status ? pill(attempt.payment_status, toneForStatus(attempt.payment_status)) : null,
            ),
          ),
          el(
            "div",
            { class: "metric-list" },
            metric("Vendor", attempt.vendor ? `${attempt.vendor.name} (${attempt.vendor.id})` : "local work"),
            metric("Job", attempt.job_id ?? "—"),
            metric("Agreed", attempt.agreed_price ? `${attempt.agreed_price} ${attempt.currency}` : "—"),
            metric("Market state", attempt.market_state ?? "—"),
            metric("Last error", attempt.last_error ?? "none"),
            metric("Approval page", attempt.approval_url ?? "—"),
            metric("Verification", attempt.verification?.details ?? "—"),
          ),
          attempt.negotiation_log?.length
            ? el(
                "div",
                { class: "muted small" },
                `Negotiation: ${attempt.negotiation_log.map((entry) => `${entry.direction} ${entry.amount ?? ""}`).join(" · ")}`,
              )
            : null,
        ),
      );
    }
    if (current?.phase === "awaiting_human_review") {
      rows.push(
        el(
          "article",
          { class: "list-item approval" },
          el(
            "div",
            { class: "list-item-head" },
            el("strong", {}, `${subtask.id} needs human review`),
            pill("awaiting_human_review", "warn"),
          ),
          el("p", { class: "muted" }, "Delivery needs your review."),
          el(
            "div",
            { class: "button-row" },
            button("Pass", () => reviewSubtask(task, subtask.id, "pass"), "primary"),
            button("Fail", () => reviewSubtask(task, subtask.id, "fail"), "danger"),
          ),
        ),
      );
    }
  }
  return rows.length ? el("div", { class: "list" }, ...rows) : empty("No attempts recorded yet.");
}

function reviewSubtask(task, subtaskId, decision) {
  const action = decision === "pass" ? "PASS" : "FAIL";
  askPhrase({
    title: `${action} review for ${subtaskId}`,
    description: `Record a human ${decision} decision for ${subtaskId}. Only inspect artifacts you trust; external deliverables are untrusted input.`,
    expected: `REVIEW ${subtaskId} ${action}`,
    confirmLabel: `Record ${decision}`,
    tone: decision === "pass" ? "primary" : "danger",
    onSubmit: async () => {
      await request(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
        method: "POST",
        body: {
          subtask_id: subtaskId,
          decision,
          phrase: `REVIEW ${subtaskId} ${action}`,
          note: `Human ${decision} from the remote UI.`,
        },
      });
      toast(`Review ${decision} recorded.`, decision === "pass" ? "success" : "warn");
      await refreshAll(true, true);
    },
  });
}

function renderExecution() {
  const snapshot = state.snapshot;
  const task = snapshot.task;
  if (!task) {
    return el(
      "div",
      { class: "stack" },
      viewHead("Execution monitor", "No active task."),
      empty("There is no active execution session."),
    );
  }
  const approvals = snapshot.approvals ?? [];
  const completed = task.subtasks.filter((item) => item.phase === "completed").length;
  const planned = task.plan?.subtasks.length ?? 0;
  return el(
    "div",
    { class: "stack" },
    viewHead("Execution monitor", "", taskActionButtons(task)),
    el(
      "div",
      { class: "grid four" },
      statCard("Task status", task.status, toneForStatus(task.status)),
      statCard("Subtask progress", `${completed} / ${planned}`, "green"),
      statCard("Engine", snapshot.engine_running ? "running" : "idle", snapshot.engine_running ? "green" : ""),
      statCard("Pending gates", String(approvals.length), approvals.length ? "amber" : ""),
    ),
    el(
      "div",
      { class: "split" },
      el(
        "div",
        { class: "stack" },
        card(
          "Subtask tree",
          el("p", { class: "task-description" }, task.description),
          task.status_detail ? el("p", { class: "task-detail" }, task.status_detail) : null,
          planned ? progress(completed, planned) : null,
          subtaskTable(task),
        ),
        card("Attempts and human review", attemptsPanel(task)),
        card("Live events", eventsPanel(snapshot.events, 30)),
      ),
      el(
        "div",
        { class: "stack" },
        card("Pending human gates", approvalsPanel(approvals)),
        card("Plan", task.plan ? el("p", { class: "task-detail" }, task.plan.summary) : empty("No plan.")),
        card(
          "Controls",
          el(
            "div",
            { class: "button-row" },
            task.id ? button("Request budget change", () => requestBudget(task.id), "warn") : null,
            button("Inspect receipts", () => switchView("transactions"), "cyan"),
          ),
        ),
      ),
    ),
  );
}

function renderMarket() {
  const market = state.market ?? {};
  const agents = state.agents ?? [];
  const jobs = state.jobs ?? [];
  const query = el("input", { value: state.agentQuery, placeholder: "skills, e.g. security audit or typescript" });
  const form = el(
    "form",
    { class: "inline-form" },
    el("div", { class: "field" }, el("label", {}, "Discover agents"), query),
    el("button", { type: "submit", class: "primary" }, "Search"),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.agentQuery = query.value.trim();
    try {
      await loadAuxData("market");
      renderView(true);
    } catch (error) {
      if (error.status !== 401) toast(error.message, "error");
    }
  });
  return el(
    "div",
    { class: "stack" },
    viewHead("Marketplace", ""),
    el(
      "div",
      { class: "grid four" },
      statCard(
        "Marketplace",
        market.connected ? "connected" : market.mode === "simulated" ? "simulated" : "offline",
        market.connected ? "green" : market.mode === "simulated" ? "violet" : "bad",
      ),
      statCard("Endpoint", market.endpoint ?? "—"),
      statCard(
        "Available balance",
        market.balance
          ? Object.entries(market.balance)
              .map(([currency, amount]) => `${amount} ${currency}`)
              .join(" · ") || "—"
          : "—",
        "cyan",
      ),
      statCard("Tools", String(market.tools?.length ?? 0)),
    ),
    market.error ? card("Marketplace problem", el("p", { class: "error" }, market.error)) : null,
    card(
      "Discover agents",
      form,
      agents.length ? el("div", { class: "list" }, ...agents.map(agentCard)) : empty("No agents found."),
    ),
    card(
      "Account jobs",
      jobs.length
        ? el(
            "div",
            { class: "table-wrap", role: "region", "aria-label": "Marketplace jobs", tabindex: "0" },
            el(
              "table",
              {},
              el(
                "thead",
                {},
                el(
                  "tr",
                  {},
                  ...["Job", "Title", "Status", "Amount", "Assignment", "Worker"].map((label) => el("th", {}, label)),
                ),
              ),
              el(
                "tbody",
                {},
                ...jobs.map((job) =>
                  el(
                    "tr",
                    {},
                    el("td", { class: "mono" }, job.job_id),
                    el("td", {}, job.title ?? "—"),
                    el("td", {}, pill(job.status ?? "unknown", toneForStatus(job.status))),
                    el("td", {}, job.amount ? `${job.amount} ${job.currency ?? ""}` : "—"),
                    el("td", {}, job.assignment_status ?? "—"),
                    el("td", {}, job.worker ?? "—"),
                  ),
                ),
              ),
            ),
          )
        : empty("No marketplace jobs reported."),
    ),
    card(
      "Market tools",
      market.tools?.length
        ? el("p", { class: "mono small" }, market.tools.join(" · "))
        : empty("No tool capabilities reported."),
    ),
  );
}

function agentCard(agent) {
  return el(
    "article",
    { class: "list-item" },
    el(
      "div",
      { class: "list-item-head" },
      el(
        "div",
        {},
        el("strong", {}, agent.name),
        el(
          "div",
          { class: "muted small" },
          `${agent.handle ?? agent.id}${agent.category ? ` · ${agent.category}` : ""}${agent.runtime ? ` · ${agent.runtime}` : ""}`,
        ),
      ),
      el(
        "div",
        { class: "task-line" },
        agent.price ? pill(`${agent.price} ${agent.currency}`, "cyan") : null,
        agent.accepting_work === false ? pill("not accepting", "warn") : null,
      ),
    ),
    el("p", { class: "muted" }, agent.description),
    el(
      "div",
      { class: "metric-list" },
      metric("Delivered jobs", String(agent.delivered_jobs ?? 0)),
      metric(
        "Success rate",
        agent.success_rate === null || agent.success_rate === undefined
          ? "unavailable"
          : `${Math.round(agent.success_rate)}%`,
      ),
      metric("Payable with", agent.payable_with?.length ? agent.payable_with.join(", ") : "not reported"),
    ),
  );
}

function renderTransactions() {
  const transactions = state.transactions;
  if (!transactions) {
    return el(
      "div",
      { class: "stack" },
      viewHead("Transaction centre", "Loading receipts…"),
      empty("Loading receipts from the verified chain."),
    );
  }
  const integrity = transactions.integrity ?? {};
  return el(
    "div",
    { class: "stack" },
    viewHead("Transaction centre", "", [button("Refresh", () => refreshAll(true, true), "ghost")]),
    el(
      "div",
      { class: "grid four" },
      statCard("Chain", integrity.ok ? "verified" : "broken", integrity.ok ? "green" : "bad"),
      statCard("Receipts", String(integrity.receipt_count ?? 0)),
      statCard("Last file", integrity.last_file ?? "—"),
      statCard("Last hash", shortHash(integrity.last_hash), "cyan"),
    ),
    integrity.ok === false
      ? card(
          "Integrity failures",
          el(
            "div",
            { class: "list" },
            ...(integrity.errors ?? []).map((issue) =>
              el(
                "div",
                { class: "list-item" },
                el("strong", {}, issue.file),
                el("div", { class: "muted" }, `${issue.code}: ${issue.message}`),
              ),
            ),
          ),
        )
      : null,
    card(
      "Receipts",
      transactions.receipts?.length
        ? el(
            "div",
            { class: "table-wrap", role: "region", "aria-label": "Receipts", tabindex: "0" },
            el(
              "table",
              {},
              el(
                "thead",
                {},
                el(
                  "tr",
                  {},
                  ...["File", "Seq", "Item", "Status", "Payment", "Amount", "Hash", ""].map((label) =>
                    el("th", {}, label),
                  ),
                ),
              ),
              el(
                "tbody",
                {},
                ...transactions.receipts.map((entry) =>
                  el(
                    "tr",
                    {},
                    el("td", { class: "mono" }, entry.file),
                    el("td", { class: "mono" }, String(entry.receipt.sequence ?? "")),
                    el("td", {}, entry.receipt.item),
                    el("td", {}, pill(entry.receipt.status, toneForStatus(entry.receipt.status))),
                    el("td", {}, pill(entry.receipt.payment_status, toneForStatus(entry.receipt.payment_status))),
                    el(
                      "td",
                      { class: "mono" },
                      `${entry.receipt.agreed_price ?? entry.receipt.planned_max} ${entry.receipt.currency}`,
                    ),
                    el("td", { class: "hash" }, shortHash(entry.receipt.hash)),
                    el(
                      "td",
                      {},
                      button("Inspect", () => inspectReceipt(entry.file), "ghost"),
                    ),
                  ),
                ),
              ),
            ),
          )
        : empty("No receipts yet."),
    ),
    card(
      "Integrity report",
      el(
        "div",
        { class: "list" },
        ...(transactions.report ?? []).map((line) => el("div", { class: "list-item mono small" }, line)),
      ),
    ),
  );
}

function renderSecurity() {
  const security = state.security;
  if (!security) {
    return el(
      "div",
      { class: "stack" },
      viewHead("Security centre", "Loading security state…"),
      empty("Loading security state."),
    );
  }
  const integrity = security.integrity ?? {};
  return el(
    "div",
    { class: "stack" },
    viewHead("Security centre", ""),
    el(
      "div",
      { class: "grid four" },
      statCard("Mode", security.mode, security.mode === "SIMULATION" ? "violet" : "green"),
      statCard("Receipt chain", integrity.ok ? "verified" : "broken", integrity.ok ? "green" : "bad"),
      statCard("Engine", security.engine_running ? "running" : "idle"),
      statCard("Pending approvals", String(security.approvals?.length ?? 0), security.approvals?.length ? "amber" : ""),
    ),
    el(
      "div",
      { class: "split" },
      el(
        "div",
        { class: "stack" },
        card("Human approvals", approvalsPanel(security.approvals ?? [])),
        card("Recent security events", eventsPanel(security.events ?? [], 30)),
        integrity.ok === false
          ? card(
              "Chain failures",
              el(
                "div",
                { class: "list" },
                ...(integrity.errors ?? []).map((issue) =>
                  el(
                    "div",
                    { class: "list-item" },
                    el("strong", {}, issue.file),
                    el("div", { class: "muted" }, `${issue.code}: ${issue.message}`),
                  ),
                ),
              ),
            )
          : null,
      ),
      el(
        "div",
        { class: "stack" },
        card(
          "Policy limits",
          el(
            "div",
            { class: "metric-list" },
            metric("Max parallel jobs", String(security.limits.max_parallel_jobs)),
            metric("Approval TTL", `${security.limits.approval_ttl_minutes} minutes`),
            metric("Contingency reserve", `${Math.round(security.limits.contingency_ratio * 100)}%`),
            metric("Market mode", security.limits.market_mode),
            metric("In-call spend", security.limits.in_call_spend ? "enabled" : "disabled"),
          ),
        ),
      ),
    ),
  );
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) {
    return el("div", { class: "stack" }, viewHead("Settings", "Loading settings…"), empty("Loading settings."));
  }
  const config = settings.config;
  const task = settings.task;
  return el(
    "div",
    { class: "stack" },
    viewHead("Settings", ""),
    el(
      "div",
      { class: "split" },
      el(
        "div",
        { class: "stack" },
        card(
          "Connections",
          el(
            "div",
            { class: "metric-list" },
            metric("Mode", config.mode),
            metric("Model provider", config.model_provider),
            metric("Model name", config.model_name ?? "not configured"),
            metric("Model key", config.model_key_configured ? "configured" : "not configured"),
            metric("Market token", config.market_token_configured ? "configured" : "not configured"),
            metric("Market mode", config.market_mode),
            metric("Hiring mode", config.hiring_mode),
            metric("Telegram", config.telegram_configured ? "configured" : "disabled"),
            metric("Web UI", config.server?.ui ? "enabled" : "disabled"),
            metric("Max parallel jobs", String(config.max_parallel_jobs)),
            metric("Approval TTL", `${config.approval_ttl_minutes} minutes`),
          ),
        ),
        task
          ? card("Task preferences", taskSettingsForm(task, config))
          : card("Task preferences", empty("No active task.")),
      ),
      el(
        "div",
        { class: "stack" },
        card(
          "Budget",
          task
            ? el(
                "div",
                { class: "stack" },
                el("p", { class: "task-detail" }, `Authorized ${task.authorized_budget} ${task.currency}.`),
                button("Request budget change", () => requestBudget(task.id), "warn"),
              )
            : empty("No active task."),
        ),
      ),
    ),
  );
}

function taskSettingsForm(task, config) {
  const locked = task.status === "executing";
  const strategy = el(
    "select",
    { name: "execution_strategy", disabled: Boolean(task.plan) },
    el(
      "option",
      { value: "plan_then_approve", selected: task.execution_strategy === "plan_then_approve" },
      "Plan first, then request approval",
    ),
    el(
      "option",
      { value: "autonomous", selected: task.execution_strategy === "autonomous" },
      "Autonomous within approved limits",
    ),
    el(
      "option",
      { value: "diy_first", selected: task.execution_strategy === "diy_first" },
      "Do it locally unless external expertise is needed",
    ),
  );
  const parallel = el("input", {
    name: "max_parallel_jobs",
    type: "number",
    min: "1",
    max: String(config.max_parallel_jobs),
    value: String(task.max_parallel_jobs),
  });
  const deadline = el("input", { name: "deadline", type: "datetime-local", value: localDateTime(task.deadline) });
  const quality = el("textarea", { name: "quality_requirements", maxlength: "4000" });
  quality.value = task.quality_requirements ?? "";
  const instructions = el("textarea", { name: "additional_instructions", maxlength: "4000" });
  instructions.value = task.additional_instructions ?? "";
  const agents = el("input", { name: "preferred_agents", value: (task.preferred_agents ?? []).join(", ") });
  const allowExternal = el("input", { type: "checkbox", name: "allow_external", checked: task.allow_external });
  const diyFirst = el("input", { type: "checkbox", name: "diy_first", checked: task.diy_first });
  const requireApproval = el("input", {
    type: "checkbox",
    name: "require_hiring_approval",
    checked: task.require_hiring_approval,
  });
  const save = el("button", { type: "submit", class: "primary" }, "Save preferences");
  const form = el(
    "form",
    { "aria-label": "Task preferences" },
    locked ? el("p", { class: "error" }, "Pause the task before changing execution preferences.") : null,
    el(
      "div",
      { class: "form-grid" },
      el("div", { class: "field" }, el("label", {}, "Strategy"), strategy),
      el("div", { class: "field" }, el("label", {}, "Maximum parallel jobs"), parallel),
      el("div", { class: "field" }, el("label", {}, "Deadline"), deadline),
      el("div", { class: "field" }, el("label", {}, "Preferred agents"), agents),
    ),
    el("div", { class: "field full" }, el("label", {}, "Quality requirements"), quality),
    el("div", { class: "field full" }, el("label", {}, "Additional instructions"), instructions),
    el(
      "div",
      { class: "button-row" },
      el("label", { class: "check" }, allowExternal, "External agents allowed"),
      el("label", { class: "check" }, diyFirst, "Try local work first"),
      el("label", { class: "check" }, requireApproval, "Require approval before hiring"),
    ),
    el("div", { class: "button-row" }, save),
  );
  save.disabled = locked;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const updates = [
      ["max_parallel_jobs", parallel.value],
      ["deadline", deadline.value ? new Date(deadline.value).toISOString() : "none"],
      ["quality_requirements", quality.value],
      ["additional_instructions", instructions.value],
      ["preferred_agents", agents.value],
      ["allow_external", allowExternal.checked ? "true" : "false"],
      ["diy_first", diyFirst.checked ? "true" : "false"],
      ["require_hiring_approval", requireApproval.checked ? "true" : "false"],
    ];
    if (!task.plan) updates.unshift(["execution_strategy", strategy.value]);
    await runAction("Save preferences", async () => {
      for (const [key, value] of updates) {
        await request(`/api/tasks/${encodeURIComponent(task.id)}/settings`, { method: "POST", body: { key, value } });
      }
    });
  });
  return form;
}

export function mountControls(root, options = null) {
  controlsRoot = root;
  embedded = options;
  lifecycle = new AbortController();
  const owner = lifecycle;
  Object.assign(state, initialState(), { view: options?.view ?? locationView() });
  loginScreen = $("#login-screen");
  appScreen = $("#app-screen");
  loginForm = $("#login-form");
  loginError = $("#login-error");
  loginButton = $("#login-button");
  accessToken = $("#access-token");
  nav = $("#main-nav");
  viewRoot = $("#view-root");
  connectionPill = $("#connection-pill");
  modePill = $("#mode-pill");
  enginePill = $("#engine-pill");
  footerMeta = $("#footer-meta");
  detailDialog = $("#detail-dialog");
  dialogTitle = $("#dialog-title");
  dialogBody = $("#dialog-body");
  toastNode = $("#toast");
  const listen = (target, type, callback) => target?.addEventListener(type, callback, { signal: owner.signal });
  listen(loginForm, "submit", async (event) => {
    event.preventDefault();
    try {
      await loginWith({ token: accessToken.value.trim() });
    } catch (error) {
      if (!owner.signal.aborted) loginError.textContent = error.message;
    }
  });
  listen($("#logout-button"), "click", async () => {
    try {
      await request("/api/auth/logout", { method: "POST", body: {} });
    } catch (error) {
      if (error.name === "AbortError") return;
    }
    showLogin("");
  });
  listen($("#dialog-close"), "click", closeDialog);
  listen(detailDialog, "click", (event) => {
    if (event.target === detailDialog) closeDialog();
  });
  listen(nav, "click", (event) => {
    const target = event.target.closest("button[data-view]");
    if (target) void switchView(target.dataset.view);
  });
  for (const type of ["input", "change"])
    listen(viewRoot, type, (event) => {
      const form = event.target.closest("form");
      if (form) form.dataset.dirty = "true";
    });
  listen(document, "visibilitychange", () => {
    if (!document.hidden && state.sse) scheduleRefresh(0);
  });
  if (!options) {
    const navigate = () => void switchView(locationView(), true);
    listen(window, "hashchange", navigate);
    listen(window, "popstate", navigate);
  }
  void bootstrap();
  return {
    navigate: (view) => switchView(view, true),
    dispose: () => {
      owner.abort();
      sessionGeneration++;
      snapshotSequence++;
      clearTimeout(toastTimer);
      clearTimeout(refreshTimer);
      clearInterval(pollTimer);
      state.sse?.close();
      state.sse = null;
      state.snapshot = null;
      closeDialog();
      viewRoot.replaceChildren();
      setBusy(false);
    },
  };
}

if (typeof document !== "undefined" && document.getElementById("app-screen")) mountControls(document);
