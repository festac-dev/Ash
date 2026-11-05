import { useEffect, useState } from "react";
import { ArrowUpRight, Check, CircleDashed, LoaderCircle, Play, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api.js";

const STATUS_LABEL = { PASS: "PASS", FAIL: "FAIL", "NOT RUN": "NOT RUN" };
const asStep = (track) => ({
  ...track,
  status: track.checks.every((check) => check.passed) ? "PASS" : "FAIL",
  error: null,
});

function TrackCard({ module, step, authenticated, busy, onVerify, onConnect }) {
  const state = step?.status ?? "NOT RUN";
  const passed = step ? step.checks.filter((check) => check.passed).length : 0;
  const checkLabel = step ? `${passed}/${step.checks.length} checks` : module.step;
  return (
    <article className="track-card">
      <div className="track-card-top">
        <span className="track-index">{module.id}</span>
        <span className={`track-state track-state-${state.toLowerCase().replace(" ", "-")}`}>
          {state === "PASS" ? <Check size={12} /> : state === "FAIL" ? <X size={12} /> : <CircleDashed size={12} />}
          {STATUS_LABEL[state]}
        </span>
      </div>
      <h3>{module.name}</h3>
      <p className="track-step">{checkLabel}</p>
      <details className="track-details">
        <summary>Details</summary>
        <dl className="track-meta">
          <div>
            <dt>Local evidence</dt>
            <dd>{step ? "Deterministic fixture" : "Not run"}</dd>
          </div>
          <div>
            <dt>Live provider</dt>
            <dd>{module.live_status.replaceAll("-", " ")}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{module.provider}</dd>
          </div>
        </dl>
        <p className="track-limit">{module.limitation}</p>
      </details>
      <button className="track-action" onClick={() => (authenticated ? onVerify() : onConnect())} disabled={busy}>
        {busy ? <LoaderCircle size={13} className="track-spin" /> : <Play size={13} />}
        {authenticated ? (step ? "Run again" : "Run track") : "Connect to verify"}
        <ArrowUpRight size={13} />
      </button>
    </article>
  );
}

export function TrackSection({ authenticated, onConnect }) {
  const [modules, setModules] = useState([]);
  const [journey, setJourney] = useState(null);
  const [results, setResults] = useState({});
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("/api/tracks")
      .then((payload) => {
        if (active) setModules(payload.tracks ?? []);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const verify = async (trackId) => {
    if (!authenticated) {
      onConnect();
      return;
    }
    setRunning(trackId || "all");
    setError("");
    try {
      const payload = await api("/api/tracks/verify", { method: "POST", body: trackId ? { track_id: trackId } : {} });
      if (payload.track) {
        setJourney(null);
        setResults((previous) => ({ ...previous, [payload.track.track_id]: asStep(payload.track) }));
      } else {
        setJourney(payload);
        setResults(Object.fromEntries(payload.steps.map((step) => [step.track_id, step])));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning("");
    }
  };
  const stepFor = (id) => results[id] ?? journey?.steps?.find((step) => step.track_id === id);
  return (
    <section id="tracks" className="tracks-section" aria-labelledby="tracks-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ONE PRODUCT · SIX WORKSTREAMS</span>
          <h2 id="tracks-heading">Proof for every track.</h2>
        </div>
        <button className="button-secondary track-verify" onClick={() => verify()} disabled={Boolean(running)}>
          {running === "all" ? <LoaderCircle size={15} className="track-spin" /> : <ShieldCheck size={15} />}
          {authenticated ? "Verify all six" : "Connect to verify"}
        </button>
      </div>
      <p className="tracks-intro">SIMULATED · Six local checks.</p>
      {journey && (
        <div className={`track-verdict ${journey.all_passed ? "is-pass" : "is-fail"}`} role="status">
          <strong>
            {journey.all_passed ? "PASS" : "FAIL"} · {journey.passed}/{journey.steps.length} workstreams
          </strong>
          <span>Journey hash {journey.journey_sha256.slice(0, 16)}…</span>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="tracks-grid">
        {modules.map((module) => (
          <TrackCard
            key={module.id}
            module={module}
            step={stepFor(module.id)}
            authenticated={authenticated}
            busy={Boolean(running)}
            onVerify={() => verify(module.id)}
            onConnect={onConnect}
          />
        ))}
        {!modules.length && !error && <p className="empty-state">Loading the six local workstreams…</p>}
      </div>
      <p className="tracks-footnote">
        <CircleDashed size={12} /> Local simulation only.
      </p>
    </section>
  );
}
