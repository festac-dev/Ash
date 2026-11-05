import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

export function Dialog({ title, onClose, children, wide = false }) {
  const ref = useRef();
  const headingId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`ash-dialog ${wide ? "dialog-wide" : ""}`}
      aria-labelledby={headingId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-title">
        <h2 id={headingId}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
