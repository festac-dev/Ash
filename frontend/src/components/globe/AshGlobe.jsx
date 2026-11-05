import CanvasGlobe from "./CanvasGlobe.jsx";
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

const GlobeScene = lazy(() => import("./GlobeScene.jsx"));
class SceneBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function AshGlobe({ network, pulses, theme, reduced, onSelect, active }) {
  const container = useRef();
  const [inView, setInView] = useState(false);
  const [entered, setEntered] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(null);
  const [command, setCommand] = useState({ action: "", sequence: 0 });
  useEffect(() => {
    setPageVisible(!document.hidden);
    const observer = new IntersectionObserver(
      (entries) => {
        setInView(entries[0].isIntersecting);
        if (entries[0].isIntersecting) setEntered(true);
      },
      { rootMargin: "80px" },
    );
    observer.observe(container.current);
    const changed = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", changed);
    };
  }, []);
  const onReady = useCallback((metrics) => {
    setReady(true);
    if (container.current) {
      container.current.dataset.particles = metrics.particles;
      container.current.dataset.renderer = metrics.renderer;
    }
  }, []);
  const onFail = useCallback(() => {
    setFailed(true);
    setReady(false);
    if (container.current) container.current.dataset.renderer = "static";
  }, []);
  useEffect(() => {
    if (!entered) return;
    // Probe before loading Three.js so unavailable GPU drivers need no exception recovery.
    const probe = document.createElement("canvas");
    let context;
    try {
      context = probe.getContext("webgl2");
    } catch {
      // Browser policy or an unavailable driver can reject context creation.
    }
    if (!context) {
      onFail();
      return;
    }
    context.getExtension("WEBGL_lose_context")?.loseContext();
    setGpuAvailable(true);
  }, [entered, onFail]);
  const rotate = (action) => setCommand((old) => ({ action, sequence: old.sequence + 1 }));
  return (
    <div
      className="globe-composition"
      ref={container}
      data-testid="globe"
      data-motion={reduced ? "reduced" : paused ? "paused" : "rotating"}
      data-visible={inView && pageVisible}
    >
      <div className="globe-grid" aria-hidden="true" />
      <div className="orbit-label orbit-label-top">
        <span className="micro-cross">+</span> EXECUTION NETWORK <span className="label-line" />
      </div>
      <div
        className="globe-canvas"
        data-testid="globe-canvas"
        tabIndex={0}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        role="img"
        aria-label="Execution network globe. Drag or use left and right arrow keys to explore. Node details are available in the network list."
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
            event.preventDefault();
            rotate(event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : "reset");
          }
        }}
      >
        {!ready && (
          <img
            className="globe-fallback"
            src="/assets/globe-fallback.svg"
            alt=""
            width="720"
            height="620"
            fetchPriority="high"
          />
        )}
        {entered && gpuAvailable && !failed && (
          <SceneBoundary onFail={onFail}>
            <Suspense fallback={null}>
              <GlobeScene
                network={network}
                pulses={active ? pulses : []}
                light={theme === "light"}
                reduced={reduced}
                rotating={!reduced && !paused}
                visible={inView && pageVisible}
                command={command}
                onHover={setHover}
                onSelect={onSelect}
                onReady={onReady}
                onContextLost={onFail}
              />
            </Suspense>
          </SceneBoundary>
        )}
        {entered && failed && (
          <CanvasGlobe
            network={network}
            light={theme === "light"}
            reduced={reduced}
            rotating={!reduced && !paused}
            visible={inView && pageVisible}
            command={command}
            onReady={onReady}
            onSelect={onSelect}
            onHover={setHover}
          />
        )}
      </div>
      <div className="globe-tag">
        <span className={`status-dot ${active ? "status-dot-active" : ""}`} />
        {active ? (network.simulated ? "Simulated execution activity" : "Execution activity") : "Ambient visualization"}
      </div>
      <div className="orbit-label orbit-label-bottom">
        AGENTS <span>·</span> EXECUTION <span>·</span> VERIFICATION
      </div>
      {hover && (
        <div className="globe-tooltip" aria-hidden="true">
          <strong>{hover.label}</strong>
          <span>
            {hover.kind} · {hover.status.replaceAll("_", " ")}
          </span>
        </div>
      )}
      <p className="globe-hint">{reduced ? "Reduced motion" : ready ? "Drag to explore" : "Execution network"}</p>
    </div>
  );
}
