import { useEffect, useRef } from "react";
import { mountControls } from "../../../web/app.js";
import styles from "../../../web/styles.css?inline";

// Reuse the established controls and API actions. The shadow root isolates their
// existing stylesheet from the workspace shell; it is not another page or session.
export default function ControlsPanel({ view, onNavigate, onUnauthorized }) {
  const host = useRef(null);
  const controller = useRef(null);
  const callbacks = useRef({ onNavigate, onUnauthorized });
  callbacks.current = { onNavigate, onUnauthorized };
  useEffect(() => {
    const root = host.current.shadowRoot || host.current.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${styles.replace(":root", ":host")}
      :host { display:block; min-width:0; font:inherit; color:var(--text); }
      .view-head { margin-top:0; }
      .detail-dialog { max-width:calc(100vw - 32px); }
    `);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `<div id="view-root" aria-live="polite"></div>
    <dialog id="detail-dialog" class="detail-dialog" aria-labelledby="dialog-title">
      <div class="dialog-head"><h2 id="dialog-title">Details</h2>
      <button id="dialog-close" class="ghost" type="button">Close</button></div>
      <div id="dialog-body"></div>
    </dialog><div id="toast" class="toast" role="status"></div>`;
    controller.current = mountControls(root, {
      view,
      onNavigate: (next) => callbacks.current.onNavigate(next),
      onUnauthorized: () => callbacks.current.onUnauthorized(),
    });
    return () => {
      controller.current.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    if (view) void controller.current?.navigate(view);
  }, [view]);
  return (
    <>
      {["tasks", "execution", "dashboard"].includes(view) && (
        <nav className="controls-tabs" aria-label="Task views">
          {[
            ["tasks", "Tasks"],
            ["execution", "Execution"],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={view === id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(id);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
      )}
      <div ref={host} className="workspace-controls" />
    </>
  );
}
