import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Network, Layers3, ShieldCheck } from "lucide-react";
import { Dialog } from "./Dialog.jsx";

const SEEN_KEY = "ash.quick-start.v1";
let dismissed = false;

export function useQuickStart(authenticated) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!authenticated) {
      setOpen(false);
      return;
    }
    const showFromLink = () => {
      if (window.location.hash !== "#guide") return false;
      setOpen(true);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return true;
    };
    if (!showFromLink()) {
      let seen = dismissed;
      try {
        seen ||= localStorage.getItem(SEEN_KEY) === "seen";
      } catch {
        /* Storage is optional. */
      }
      setOpen(!seen);
    }
    window.addEventListener("hashchange", showFromLink);
    return () => window.removeEventListener("hashchange", showFromLink);
  }, [authenticated]);
  const close = () => {
    dismissed = true;
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "seen");
    } catch {
      /* Never block access on storage policy. */
    }
  };
  return { open: authenticated && open, close, show: () => authenticated && setOpen(true) };
}

const steps = [
  { Icon: Layers3, title: "Tasks & budgets", text: "Your work, plans and spending limits in one place." },
  { Icon: Network, title: "A live network", text: "Agents and task dependencies, connected in 3D." },
  { Icon: ShieldCheck, title: "Decisions & receipts", text: "Approvals, results and the evidence behind them." },
];

export function QuickStart({ onClose, onFinish }) {
  const [step, setStep] = useState(0);
  const { Icon, title, text } = steps[step];
  return (
    <Dialog title="Welcome to Ash" onClose={onClose}>
      <div className="guide-step" aria-live="polite" aria-atomic="true">
        <div className="guide-symbol" aria-hidden="true">
          <Icon size={30} />
        </div>
        <span className="eyebrow">
          {step + 1} / {steps.length}
        </span>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      <div className="guide-actions">
        {step ? (
          <button className="button-text" onClick={() => setStep(step - 1)}>
            <ArrowLeft size={15} /> Back
          </button>
        ) : (
          <button className="button-text" onClick={onClose}>
            Skip guide
          </button>
        )}
        <button className="button-primary" onClick={() => (step === steps.length - 1 ? onFinish() : setStep(step + 1))}>
          {step === steps.length - 1 ? "Get started" : "Next"}
          <ArrowRight size={16} />
        </button>
      </div>
    </Dialog>
  );
}
