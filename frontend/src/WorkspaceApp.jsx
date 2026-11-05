import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CircleDot,
  CircleHelp,
  Layers3,
  Menu,
  Moon,
  Network,
  Plus,
  ShieldCheck,
  Settings,
  ListChecks,
  LockKeyhole,
  LogOut,
  Sun,
  X,
} from "lucide-react";
import { useAsh } from "./lib/useAsh.jsx";
import { useAppearance } from "./lib/useAppearance.js";
import { projectNetwork, describeStatus, nodeTone } from "./lib/network.js";
import { SiteBrand } from "./components/SiteBrand.jsx";
import { AshGlobe } from "./components/globe/AshGlobe.jsx";
import { Dialog } from "./components/Dialog.jsx";
import { PanelBoundary } from "./components/PanelBoundary.jsx";
import { QuickStart, useQuickStart } from "./components/QuickStart.jsx";
import { DepthCard } from "./components/FeatureCard.jsx";
import { TrackSection } from "./components/TrackSection.jsx";
const LoginForm = lazy(() => import("./components/WorkspaceDialogs.jsx").then((m) => ({ default: m.LoginForm })));
const ControlsPanel = lazy(() => import("./components/ControlsPanel.jsx"));
const CreateTaskDialog = lazy(() =>
  import("./components/WorkspaceDialogs.jsx").then((m) => ({ default: m.CreateTaskDialog })),
);
const ChatDialog = lazy(() => import("./components/WorkspaceDialogs.jsx").then((m) => ({ default: m.ChatDialog })));
const DataDialog = lazy(() => import("./components/WorkspaceDialogs.jsx").then((m) => ({ default: m.DataDialog })));

const views = {
  overview: ["Overview", Layers3],
  tasks: ["Tasks & execution", CircleDot],
  agents: ["Agents", Network],
  receipts: ["Receipts", ShieldCheck],
  activity: ["Activity", Activity],
  tracks: ["Track verification", ListChecks],
  security: ["Approvals & security", LockKeyhole],
  settings: ["Settings", Settings],
};
const controlViews = new Set(["tasks", "execution", "market", "transactions", "security", "settings", "dashboard"]);
function locationView() {
  if (typeof window === "undefined") return "overview";
  const hash = window.location.hash.slice(1);
  if (views[hash] || controlViews.has(hash)) return hash;
  return ["/workspace/controls", "/console"].includes(window.location.pathname) ? "tasks" : "overview";
}
export default function WorkspaceApp() {
  const ash = useAsh();
  const guide = useQuickStart(ash.authenticated);
  const { theme, reduced, toggleTheme } = useAppearance();
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [small, setSmall] = useState(false);
  const [view, setView] = useState("overview");
  const [controlsVisited, setControlsVisited] = useState(false);
  const sidebar = useRef(null),
    toggle = useRef(null),
    content = useRef(null);
  useEffect(() => {
    setView(locationView());
    try {
      setCollapsed(localStorage.getItem("ash.sidebar.collapsed") === "true");
    } catch {
      /* Storage is optional. */
    }
    const media = matchMedia("(max-width: 720px)");
    const resize = () => {
      setSmall(media.matches);
      setMenu(false);
    };
    const historyChanged = () => {
      setView(locationView());
      setMenu(false);
    };
    resize();
    media.addEventListener("change", resize);
    window.addEventListener("hashchange", historyChanged);
    window.addEventListener("popstate", historyChanged);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("hashchange", historyChanged);
      window.removeEventListener("popstate", historyChanged);
    };
  }, []);
  useEffect(() => {
    if (ash.authenticated && controlViews.has(view)) setControlsVisited(true);
  }, [view, ash.authenticated]);
  useEffect(() => {
    if (!small || !menu) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (sidebar.current?.querySelector('[aria-current="page"]') || sidebar.current?.querySelector("a"))?.focus();
    const keys = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
        toggle.current?.focus();
      }
      if (event.key !== "Tab") return;
      const items = [toggle.current, ...sidebar.current.querySelectorAll("a")];
      const index = items.indexOf(document.activeElement);
      if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault();
        items[event.shiftKey ? items.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener("keydown", keys, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keys, true);
    };
  }, [small, menu]);
  const navigate = (next) => {
    if (!views[next] && !controlViews.has(next)) return;
    if (window.location.hash !== `#${next}`) history.pushState(null, "", `#${next}`);
    setView(next);
    setMenu(false);
    requestAnimationFrame(() => content.current?.focus());
  };
  const closeMenu = () => {
    setMenu(false);
    toggle.current?.focus();
  };
  const switchSidebar = () => {
    if (small) {
      if (menu) closeMenu();
      else setMenu(true);
    } else
      setCollapsed((old) => {
        try {
          localStorage.setItem("ash.sidebar.collapsed", String(!old));
        } catch {
          /* Storage is optional. */
        }
        return !old;
      });
  };
  const activeView = ["execution", "dashboard"].includes(view)
    ? "tasks"
    : view === "market"
      ? "agents"
      : view === "transactions"
        ? "receipts"
        : view;
  const [notice, setNotice] = useState("");
  const network = useMemo(() => projectNetwork(ash.snapshot), [ash.snapshot]);
  const live = ash.connection === "connected";
  useEffect(() => {
    if (!ash.authenticated) {
      setSelected(null);
      setModal(null);
      setMenu(false);
      setControlsVisited(false);
    }
  }, [ash.authenticated]);
  useEffect(() => {
    setSelected((value) => (value ? (network.nodes.find((node) => node.id === value.id) ?? null) : null));
  }, [network]);
  const open = (kind) => {
    setMenu(false);
    if (!ash.authenticated) return;
    if (views[kind]) navigate(kind);
    else setModal(kind);
  };
  const logout = async () => {
    try {
      await ash.logout();
      setModal(null);
      setSelected(null);
    } catch (error) {
      setNotice(error.message);
    }
  };
  const stat = (value) => (ash.snapshot ? (value ?? "—") : "—");
  return (
    <>
      <a
        href="#main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="site-shell workspace-page" id="top">
        <header className="site-header">
          <SiteBrand />
          {ash.simulated && <span className="demo-label">DEMO</span>}
          <span className="header-divider" />
          <span className="workspace-name">Workspace</span>
          <div className="header-actions">
            {ash.authenticated && (
              <span className="connection-label">
                <span className={`status-dot ${live ? "status-dot-active" : ""}`} />
                {live ? "Workspace connected" : ash.connection === "reconnecting" ? "Reconnecting" : "Not connected"}
              </span>
            )}
            {ash.authenticated && (
              <button
                className="icon-button"
                aria-label="Help"
                onClick={() => {
                  setMenu(false);
                  setModal(null);
                  setSelected(null);
                  guide.show();
                }}
              >
                <CircleHelp size={18} />
              </button>
            )}
            <button
              className="icon-button theme-toggle"
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {ash.authenticated && (
              <button
                className="button-header workspace-disconnect"
                aria-label="Disconnect"
                title="Disconnect"
                onClick={logout}
              >
                <LogOut size={18} aria-hidden="true" />
                <span>Disconnect</span>
              </button>
            )}
            {ash.authenticated && (
              <button
                ref={toggle}
                className="icon-button workspace-menu"
                aria-label={
                  small
                    ? menu
                      ? "Close navigation"
                      : "Open navigation"
                    : collapsed
                      ? "Expand sidebar"
                      : "Collapse sidebar"
                }
                aria-expanded={small ? menu : !collapsed}
                aria-controls="workspace-sidebar"
                onClick={switchSidebar}
              >
                {menu ? <X size={20} /> : <Menu size={20} />}
              </button>
            )}
          </div>
        </header>
        {!ash.authenticated ? (
          <main id="main" className="workspace-gate" tabIndex={-1}>
            <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
            <h1>Connect your workspace</h1>
            {!ash.sessionReady ? (
              <p role="status">Connecting…</p>
            ) : (
              <Suspense fallback={<p role="status">Loading sign-in…</p>}>
                <LoginForm login={ash.login} />
              </Suspense>
            )}
            <a className="button-text" href="/">
              Back to Ash
            </a>
            {ash.error && (
              <p className="error-text" role="status">
                {ash.error}
              </p>
            )}
          </main>
        ) : (
          <div className={`workspace-layout ${collapsed ? "sidebar-collapsed" : ""}`}>
            {small && menu && (
              <button
                className="sidebar-backdrop"
                aria-label="Close navigation backdrop"
                tabIndex={-1}
                onClick={closeMenu}
              />
            )}
            <nav
              id="workspace-sidebar"
              ref={sidebar}
              className={`workspace-sidebar ${menu ? "sidebar-open" : ""}`}
              aria-label="Workspace navigation"
              inert={small && !menu ? true : undefined}
              onKeyDown={(event) => {
                const items = [...sidebar.current.querySelectorAll("a")];
                const index = items.indexOf(document.activeElement);
                if (event.key === "Escape" && small) {
                  event.preventDefault();
                  closeMenu();
                }
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  items[
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                  ]?.focus();
                }
              }}
            >
              {Object.entries(views)
                .filter(([id]) => id !== "tracks" || ash.simulated)
                .map(([id, [label, Icon]]) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    aria-label={label}
                    title={collapsed && !small ? label : undefined}
                    aria-current={activeView === id ? "page" : undefined}
                    onClick={(event) => {
                      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
                        event.preventDefault();
                        navigate(id);
                      }
                    }}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span className="sidebar-label">{label}</span>
                  </a>
                ))}
            </nav>
            <main
              id="main"
              ref={content}
              tabIndex={-1}
              className="workspace-main"
              inert={small && menu ? true : undefined}
            >
              <div className="workspace-heading" hidden={controlViews.has(view)}>
                <div>
                  <span className="eyebrow">{ash.simulated ? "SIMULATED WORKSPACE" : "YOUR WORKSPACE"}</span>
                  <h1>{views[view]?.[0] || "Workspace"}</h1>
                </div>
                <div className="workspace-actions">
                  <button className="button-secondary" onClick={() => open("chat")}>
                    Talk to ASH
                  </button>
                  <button className="button-primary" onClick={() => open("create")}>
                    <Plus size={16} /> New task
                  </button>
                </div>
              </div>
              {(ash.error || notice) && (
                <div className="connection-notice" role="status">
                  {notice || ash.error}
                  <button
                    className="button-text"
                    onClick={() => {
                      setNotice("");
                      ash.refresh().catch((error) => setNotice(error.message));
                    }}
                  >
                    Retry connection
                  </button>
                </div>
              )}
              <div hidden={view !== "overview"} className="workspace-view">
                <section className="metric-strip" aria-label="Current workspace metrics">
                  {[
                    {
                      label: "Active agents",
                      value: stat(network.activeAgents),
                      Icon: CircleDot,
                      view: "agents",
                    },
                    {
                      label: "Tasks in progress",
                      value: stat(network.running),
                      Icon: Layers3,
                      view: "tasks",
                    },
                    {
                      label: "Workflow connections",
                      value: stat(network.edges.length),
                      Icon: Network,
                      view: "agents",
                    },
                    {
                      label: "Verified receipts",
                      value: stat(network.verified),
                      Icon: ShieldCheck,
                      view: "receipts",
                    },
                  ].map(({ label, value, Icon, view }) => (
                    <button className="metric-card" key={label} onClick={() => open(view)}>
                      <div>
                        <Icon size={16} />
                        <span>{label}</span>
                        <ArrowUpRight size={13} />
                      </div>
                      <strong>{value}</strong>
                    </button>
                  ))}
                </section>
                <div className="workspace-overview-grid">
                  <DepthCard as="section" reduced={reduced} className="glass-card active-task-card">
                    <div className="card-heading">
                      <span>
                        <Layers3 size={16} /> Active task
                      </span>
                      <span className="small-badge">{describeStatus(ash.snapshot?.task?.status ?? "idle")}</span>
                    </div>
                    <h2>{ash.snapshot?.task?.description ?? "What would you like to accomplish?"}</h2>
                    <p>
                      {ash.snapshot?.task
                        ? `${ash.snapshot.task.subtasks.filter((item) => item.phase === "completed").length} of ${ash.snapshot.task.subtasks.length} subtasks completed.`
                        : "Create your first task."}
                    </p>
                    {ash.snapshot?.ledger && (
                      <dl className="workspace-budget">
                        <dt>Available</dt>
                        <dd>
                          {ash.snapshot.ledger.available} {ash.snapshot.ledger.currency}
                        </dd>
                        <dt>Authorized</dt>
                        <dd>
                          {ash.snapshot.ledger.authorized} {ash.snapshot.ledger.currency}
                        </dd>
                      </dl>
                    )}
                    {network.nodes.some((node) => node.kind === "task") && (
                      <div className="node-list" aria-label="Network nodes">
                        {network.nodes
                          .filter((node) => node.kind === "task")
                          .map((node) => (
                            <button key={node.id} onClick={() => setSelected(node)}>
                              <span className={`node-indicator ${nodeTone(node)}`} />
                              <span>{node.label}</span>
                              <small>{describeStatus(node.status)}</small>
                            </button>
                          ))}
                      </div>
                    )}
                    <a
                      className="button-secondary"
                      href="#tasks"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate("tasks");
                      }}
                    >
                      {ash.snapshot?.task ? "Open task" : "Browse tasks"}
                      <ArrowUpRight size={15} />
                    </a>
                    <div className="pending-decisions">
                      <strong>
                        {ash.snapshot?.approvals?.filter((item) => item.status === "pending").length ?? 0} pending
                        approvals
                      </strong>
                      <a
                        href="#security"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate("security");
                        }}
                      >
                        Review decisions
                      </a>
                    </div>
                  </DepthCard>
                  <section className="workspace-network" aria-label="Execution network">
                    <div className="card-heading">
                      <span>
                        <Network size={16} /> Execution network
                      </span>
                      <span className="subtle-label">{ash.simulated ? "SIMULATION" : "RECORDED ACTIVITY"}</span>
                    </div>
                    <AshGlobe
                      network={network}
                      pulses={ash.pulses}
                      theme={theme}
                      reduced={reduced}
                      onSelect={setSelected}
                      active={live && ash.pulses.length > 0}
                    />
                  </section>
                </div>
                <DepthCard as="section" reduced={reduced} className="glass-card workspace-task-list">
                  <div className="card-heading">
                    <h2>Recent tasks</h2>
                    <button className="button-text" onClick={() => open("tasks")}>
                      View all
                    </button>
                  </div>
                  {ash.snapshot?.tasks?.length ? (
                    <ul>
                      {ash.snapshot.tasks.slice(0, 5).map((task) => (
                        <li key={task.id}>
                          <div>
                            <strong>{task.description}</strong>
                            <span>
                              {task.budget} {task.currency} authorized
                            </span>
                          </div>
                          <span className="small-badge">{describeStatus(task.status)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No tasks yet.</p>
                  )}
                </DepthCard>
              </div>
              {view === "tracks" && ash.simulated && <TrackSection authenticated={ash.authenticated} />}
              {controlsVisited && (
                <div hidden={!controlViews.has(view)} className="workspace-view">
                  <Suspense fallback={<p role="status">Loading controls…</p>}>
                    <ControlsPanel
                      view={controlViews.has(view) ? view : null}
                      onNavigate={navigate}
                      onUnauthorized={ash.endSession}
                    />
                  </Suspense>
                </div>
              )}
              {["agents", "receipts", "activity"].includes(view) && (
                <Suspense fallback={<p role="status">Loading…</p>}>
                  <DataDialog
                    inline
                    kind={view}
                    snapshot={ash.snapshot}
                    network={network}
                    onSelect={setSelected}
                    onNavigate={navigate}
                  />
                </Suspense>
              )}
            </main>
          </div>
        )}
      </div>
      {ash.authenticated && guide.open && (
        <QuickStart
          onClose={guide.close}
          onFinish={() => {
            guide.close();
          }}
        />
      )}
      {!guide.open && (
        <PanelBoundary key={modal} onClose={() => setModal(null)}>
          <Suspense
            fallback={
              <Dialog title="Opening…" onClose={() => setModal(null)}>
                <p role="status">Loading view…</p>
              </Dialog>
            }
          >
            {modal === "create" && ash.authenticated && (
              <CreateTaskDialog onClose={() => setModal(null)} onCreated={ash.refresh} />
            )}
            {modal === "chat" && ash.authenticated && (
              <ChatDialog taskId={ash.snapshot?.task?.id} onClose={() => setModal(null)} />
            )}
            {ash.authenticated && ["tasks", "agents", "activity", "receipts"].includes(modal) && (
              <DataDialog
                kind={modal}
                snapshot={ash.snapshot}
                network={network}
                onClose={() => setModal(null)}
                onSelect={(node) => {
                  setModal(null);
                  setSelected(node);
                }}
              />
            )}
          </Suspense>
        </PanelBoundary>
      )}
      {!guide.open && selected && ash.authenticated && (
        <Dialog title={selected.label} onClose={() => setSelected(null)}>
          <span className="small-badge">
            {network.simulated ? "Simulation · " : ""}
            {selected.kind} · {describeStatus(selected.status)}
          </span>
          <p className="node-description">{selected.detail}</p>
          <dl className="node-details">
            <dt>Verification</dt>
            <dd>{selected.verified ? "Acceptance checks passed" : "No passing verification recorded"}</dd>
            <dt>Marketplace assignment</dt>
            <dd>{selected.jobId || "Not assigned"}</dd>
          </dl>
          <a
            className="button-secondary"
            href="#tasks"
            onClick={(event) => {
              event.preventDefault();
              setSelected(null);
              navigate("tasks");
            }}
          >
            Inspect task controls <ArrowUpRight size={15} />
          </a>
        </Dialog>
      )}
    </>
  );
}
