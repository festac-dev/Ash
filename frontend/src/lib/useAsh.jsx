import { useCallback, useEffect, useRef, useState } from "react";
import { api, bootstrapSession } from "./api.js";
import { adaptEngineEvent, diffNetwork } from "./network.js";

export function useAsh() {
  const [simulated, setSimulated] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [connection, setConnection] = useState("disconnected");
  const [error, setError] = useState("");
  const [pulses, setPulses] = useState([]);
  const [sessionRevision, reconnect] = useState(0);
  const stopConnection = useRef(null);
  const current = useRef(null);
  const epoch = useRef(0);
  const requested = useRef(0),
    applied = useRef(0);
  const seen = useRef(new Set());
  const push = useCallback((events) => {
    const fresh = events.filter((e) => e && !seen.current.has(e.id));
    fresh.forEach((e) => seen.current.add(e.id));
    if (seen.current.size > 500) seen.current = new Set([...seen.current].slice(-250));
    if (fresh.length)
      setPulses((old) =>
        [
          ...old.filter((e) => Date.now() - e.receivedAt < 7000),
          ...fresh.map((e) => ({ ...e, receivedAt: Date.now() })),
        ].slice(-12),
      );
  }, []);
  const clear = useCallback(() => {
    epoch.current++;
    current.current = null;
    seen.current.clear();
    setSnapshot(null);
    setPulses([]);
    setAuthenticated(false);
    setConnection("disconnected");
  }, []);
  const refresh = useCallback(
    async (signal) => {
      const generation = epoch.current;
      const request = ++requested.current;
      const next = await api("/api/state", { signal });
      if (generation !== epoch.current || request < applied.current) return;
      applied.current = request;
      if (current.current?.task?.id !== next.task?.id) {
        setPulses([]);
        seen.current.clear();
      }
      push(diffNetwork(current.current, next));
      current.current = next;
      setSnapshot(next);
      setError("");
    },
    [push],
  );
  useEffect(() => {
    let active = true;
    const generation = epoch.current;
    bootstrapSession()
      .then((session) => {
        if (active && generation === epoch.current) {
          setAuthenticated(session.authenticated);
          setSimulated(session.mode === "SIMULATION");
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setSessionReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    const source = new EventSource("/api/events");
    let timer;
    let busy = false;
    let queued = false;
    const fetchState = async () => {
      if (abort.signal.aborted) return;
      if (document.hidden) {
        queued = true;
        return;
      }
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      try {
        await refresh(abort.signal);
        if (!abort.signal.aborted && source.readyState === EventSource.OPEN) setConnection("connected");
      } catch (e) {
        if (!abort.signal.aborted) {
          setConnection("reconnecting");
          setError(e.message);
          if (e.status === 401) clear();
        }
      } finally {
        busy = false;
        if (queued && !abort.signal.aborted) {
          queued = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(fetchState, 300);
    };
    source.onopen = () => {
      if (!abort.signal.aborted) {
        setConnection("connected");
        fetchState();
      }
    };
    source.onerror = () => {
      if (!abort.signal.aborted) {
        setConnection("reconnecting");
        setPulses([]);
      }
    };
    source.addEventListener("engine", (e) => {
      if (abort.signal.aborted) return;
      try {
        if (!document.hidden) push([adaptEngineEvent(JSON.parse(e.data), current.current)]);
      } catch {
        /* Ignore malformed events. */
      }
      schedule();
    });
    for (const type of ["refresh", "server"]) source.addEventListener(type, schedule);
    fetchState();
    const poll = setInterval(fetchState, 15000);
    const visibility = () => {
      if (!document.hidden) {
        queued = false;
        fetchState();
      } else setPulses([]);
    };
    document.addEventListener("visibilitychange", visibility);
    const stop = () => {
      if (abort.signal.aborted) return;
      epoch.current++;
      abort.abort();
      source.close();
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visibility);
    };
    stopConnection.current = stop;
    return () => {
      stop();
      if (stopConnection.current === stop) stopConnection.current = null;
    };
  }, [authenticated, clear, refresh, push, sessionRevision]);
  useEffect(() => {
    if (!pulses.length) return;
    const timer = setTimeout(() => setPulses((old) => old.filter((e) => Date.now() - e.receivedAt < 7000)), 7500);
    return () => clearTimeout(timer);
  }, [pulses]);
  const login = async (token) => {
    await api("/api/auth/login", { method: "POST", body: { token } });
    epoch.current++;
    setAuthenticated(true);
    setError("");
  };
  const logout = async () => {
    // Stop transport before revoking the cookie so queued refreshes cannot race logout.
    stopConnection.current?.();
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
      clear();
    } catch (error) {
      reconnect((value) => value + 1);
      throw error;
    }
  };
  return {
    simulated,
    authenticated,
    sessionReady,
    snapshot,
    connection,
    error,
    pulses,
    login,
    logout,
    refresh,
    endSession: clear,
  };
}
