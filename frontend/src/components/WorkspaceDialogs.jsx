import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle, LockKeyhole, Send } from "lucide-react";
import { Dialog } from "./Dialog.jsx";
import { api, requestId } from "../lib/api.js";
import { describeStatus } from "../lib/network.js";

export function LoginForm({ login, onClose = () => {} }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const token = new FormData(e.currentTarget).get("token");
    try {
      await login(token.trim());
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="dialog-emblem">
        <LockKeyhole size={24} />
      </div>
      <form onSubmit={submit} className="stack-form">
        <label htmlFor="token">Access code</label>
        <input id="token" name="token" type="password" autoComplete="one-time-code" minLength={16} required autoFocus />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="button-primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect workspace"}
          <ArrowUpRight size={17} />
        </button>
      </form>
    </>
  );
}

export function LoginDialog({ login, onClose }) {
  return (
    <Dialog title="Connect your workspace" onClose={onClose}>
      <LoginForm login={login} onClose={onClose} />
    </Dialog>
  );
}

export function CreateTaskDialog({ onClose, onCreated }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: {
          description: data.get("description"),
          budget: data.get("budget"),
          currency: data.get("currency"),
          execution_strategy: "plan_then_approve",
          require_hiring_approval: true,
        },
      });
      onClose();
      // Creation already succeeded; a refresh failure must not offer a duplicate submission.
      await onCreated().catch(() => undefined);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Give ASH a task" onClose={onClose}>
      <form onSubmit={submit} className="stack-form">
        <label htmlFor="description">What would you like to accomplish?</label>
        <textarea
          id="description"
          name="description"
          minLength={3}
          maxLength={10000}
          rows={4}
          required
          autoFocus
          placeholder="Create a launch checklist for my project…"
        />
        <div className="form-columns">
          <div>
            <label htmlFor="budget">Budget limit</label>
            <input
              id="budget"
              name="budget"
              inputMode="decimal"
              pattern="[0-9]+(\.[0-9]+)?"
              placeholder="25.00"
              required
            />
          </div>
          <div>
            <label htmlFor="currency">Currency</label>
            <select id="currency" name="currency">
              <option>USDC</option>
              <option>USD</option>
            </select>
          </div>
        </div>
        <p className="form-note">
          <LockKeyhole size={14} /> Draft only. Approval required to run.
        </p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="button-primary" disabled={busy}>
          {busy ? "Creating…" : "Create task draft"}
          <ArrowUpRight size={17} />
        </button>
      </form>
    </Dialog>
  );
}

export function DataDialog({ kind, snapshot, network, onClose, onSelect, inline = false, onNavigate }) {
  const titles = {
    tasks: "Your tasks",
    agents: "Agents in this workflow",
    activity: "Execution activity",
    receipts: "Verifiable receipts",
  };
  const Container = inline ? "section" : Dialog;
  return (
    <Container
      {...(inline
        ? { className: "glass-card workspace-data", "aria-label": titles[kind] }
        : { title: titles[kind] ?? "Network entities", onClose, wide: true })}
    >
      {snapshot?.mode === "SIMULATION" && <span className="demo-label">DEMO</span>}
      {kind === "tasks" &&
        (snapshot?.tasks?.length ? (
          <div className="data-list">
            {snapshot.tasks.map((t) => (
              <article key={t.id}>
                <div>
                  <strong>{t.description}</strong>
                  <p>
                    {t.budget} {t.currency} authorized · {t.completed_subtasks}/{t.plan_subtasks} completed
                  </p>
                </div>
                <span className="small-badge">{describeStatus(t.status)}</span>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">No tasks to show yet.</p>
        ))}
      {kind === "agents" &&
        (network.nodes.filter((n) => n.kind === "agent").length ? (
          <div className="data-list">
            {network.nodes
              .filter((n) => n.kind === "agent")
              .map((n) => (
                <button key={n.id} onClick={() => onSelect(n)}>
                  <div>
                    <strong>{n.label}</strong>
                    <p>{n.detail}</p>
                  </div>
                  <span className="small-badge">{n.status}</span>
                </button>
              ))}
          </div>
        ) : (
          <p className="empty-state">No agents recorded for the current workflow.</p>
        ))}
      {kind === "activity" &&
        (snapshot?.events?.length ? (
          <div className="data-list">
            {snapshot.events
              .slice(-30)
              .reverse()
              .map((e, i) => (
                <article key={`${e.at}-${i}`}>
                  <div>
                    <strong>{describeStatus(e.code).toLowerCase()}</strong>
                    <p>{e.message}</p>
                  </div>
                  <time dateTime={e.at}>
                    {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </article>
              ))}
          </div>
        ) : (
          <p className="empty-state">No activity yet.</p>
        ))}
      {kind === "receipts" &&
        (snapshot?.receipts?.length ? (
          <div className="data-list">
            {snapshot.receipts.map(({ receipt: r }) => (
              <article key={r.transaction_id}>
                <div>
                  <strong>{r.item}</strong>
                  <p>
                    {r.mode === "simulated" ? "Simulation · " : ""}
                    {describeStatus(r.payment_status)} · {r.agreed_price ?? "0"} {r.currency}
                  </p>
                  <code>{r.hash.slice(0, 20)}…</code>
                </div>
                <span className="small-badge">
                  {r.check_result.passed ? "Checks passed" : describeStatus(r.check_result.status)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">Completed work will appear here with its receipt.</p>
        ))}
      {snapshot && (
        <a
          className="button-secondary dialog-link"
          href="#tasks"
          onClick={(event) => {
            if (onNavigate) {
              event.preventDefault();
              onNavigate(kind === "agents" ? "market" : kind === "receipts" ? "transactions" : "tasks");
            }
          }}
        >
          {kind === "agents" ? "Browse marketplace" : kind === "receipts" ? "View transactions" : "Open task controls"}
          <ArrowUpRight size={16} />
        </a>
      )}
    </Container>
  );
}

export function ChatDialog({ taskId, onClose }) {
  const [messages, setMessages] = useState([]),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    retry = useRef(null);
  useEffect(() => {
    const abort = new AbortController();
    const id = ++generation.current;
    setMessages([]);
    setInput("");
    setError("");
    setBusy(false);
    retry.current = null;
    api(`/api/chat${taskId ? `?task_id=${encodeURIComponent(taskId)}` : ""}`, { signal: abort.signal })
      .then((h) => {
        if (generation.current === id) setMessages(h.messages);
      })
      .catch((e) => {
        if (!abort.signal.aborted && generation.current === id) setError(e.message);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [taskId]);
  const submit = async (e) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true);
    setError("");
    const id = ++generation.current;
    if (!retry.current || retry.current.message !== input.trim())
      retry.current = { message: input.trim(), request_id: requestId() };
    try {
      const history = await api("/api/chat", { method: "POST", body: { task_id: taskId || null, ...retry.current } });
      if (generation.current === id) {
        setMessages(history.messages);
        setInput("");
        retry.current = null;
      }
    } catch (e) {
      if (generation.current === id) setError(e.message);
    } finally {
      if (generation.current === id) setBusy(false);
    }
  };
  return (
    <Dialog title="Talk to ASH" onClose={onClose} wide>
      <div className="chat-messages" role="log" aria-label="Conversation">
        {messages.length ? (
          messages.map((m, i) => (
            <article key={i} className={`chat-turn ${m.role}`}>
              <span>{m.role === "assistant" ? "ASH" : "You"}</span>
              <p>{m.content}</p>
            </article>
          ))
        ) : (
          <p className="empty-state">Ask about your plan, budget, or next steps.</p>
        )}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-input">
          Message to ASH
        </label>
        <textarea
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask ASH about your work…"
          maxLength={4000}
          rows={2}
          required
        />
        <button className="icon-button" aria-label="Send message" disabled={busy}>
          {busy ? <LoaderCircle size={19} /> : <Send size={19} />}
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
