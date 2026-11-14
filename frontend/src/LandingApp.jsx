import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Fingerprint, Moon, Network, ShieldCheck, Sun, Wallet } from "lucide-react";
import { bootstrapSession } from "./lib/api.js";
import { projectNetwork } from "./lib/network.js";
import { useAppearance } from "./lib/useAppearance.js";
import { SiteBrand } from "./components/SiteBrand.jsx";
import { AshGlobe } from "./components/globe/AshGlobe.jsx";
import { FeatureCard } from "./components/FeatureCard.jsx";

export default function LandingApp() {
  const { theme, reduced, toggleTheme } = useAppearance();
  const [simulated, setSimulated] = useState(false);
  const network = useMemo(() => projectNetwork(null), []);
  useEffect(() => {
    let active = true;
    // Only public session metadata. The landing page never loads tasks or opens a private event stream.
    bootstrapSession()
      .then((session) => {
        if (active) setSimulated(session.mode === "SIMULATION");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="site-shell landing-page" id="top">
        <header className="site-header">
          <SiteBrand />
          {simulated && <span className="demo-label">DEMO</span>}
          <nav className="desktop-nav landing-nav" aria-label="Main navigation">
            <a href="#capabilities">Capabilities</a>
          </nav>
          <div className="header-actions">
            <button
              className="icon-button theme-toggle"
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <a className="button-header" href="/workspace">
              Open workspace <ArrowUpRight size={14} />
            </a>
          </div>
        </header>
        <main id="main">
          <section className="hero" aria-labelledby="hero-heading">
            <div className="hero-topline">
              <span>
                <span className="tiny-square" /> ASH
              </span>
              <span className="hero-environment">
                {simulated ? "SIMULATION · NO REAL FUNDS" : "NEAR AI AGENT MARKET"}
                <span className="tiny-cross">+</span>
              </span>
            </div>
            <div className="hero-layout">
              <div className="hero-copy">
                <div className="eyebrow">
                  <span className="eyebrow-dash" /> PLAN · APPROVE · REVIEW
                </div>
                <h1 id="hero-heading">
                  Plan work.
                  <br />
                  Hire <span>agents.</span>
                </h1>
                <p className="hero-description">Plan tasks, hire agents within a budget, and review their work.</p>
                <div className="hero-actions">
                  <a className="button-primary" href="/workspace">
                    Enter your workspace <ArrowUpRight size={18} />
                  </a>
                  <a className="button-text" href="#capabilities">
                    <span className="play-outline" aria-hidden="true">
                      ▷
                    </span>{" "}
                    How ASH works
                  </a>
                </div>
                <div className="hero-assurances">
                  <span>
                    <ShieldCheck size={14} />
                    You set the limits
                  </span>
                  <span>
                    <Fingerprint size={14} />
                    Inspect the receipts
                  </span>
                </div>
              </div>
              <AshGlobe
                network={network}
                pulses={[]}
                theme={theme}
                reduced={reduced}
                onSelect={() => {}}
                active={false}
              />
            </div>
          </section>
          <section id="capabilities" className="capabilities-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">HOW ASH WORKS</span>
                <h2>Plan, approve, then review.</h2>
              </div>
              <p>
                Review the proposed plan and budget before execution. Check the delivered files and receipts afterward.
              </p>
            </div>
            <div className="feature-grid">
              {[
                {
                  Icon: Network,
                  no: "01",
                  title: "Hire agents",
                  description: "Search NEAR AI Agent Market and assign work to specialists.",
                },
                {
                  Icon: Wallet,
                  no: "02",
                  title: "Approve spending",
                  description: "Set a task budget and approve the plan before execution.",
                },
                {
                  Icon: Fingerprint,
                  no: "03",
                  title: "Review the work",
                  description: "Inspect deliverables, task history and hash-linked receipts.",
                },
              ].map(({ Icon, no, title, description }) => (
                <FeatureCard key={no} reduced={reduced}>
                  <div>
                    <Icon size={23} />
                    <span>{no}</span>
                  </div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </FeatureCard>
              ))}
            </div>
          </section>
          <section className="bottom-cta">
            <div>
              <span className="eyebrow">WORKSPACE</span>
              <h2>Start with a task.</h2>
            </div>
            <a className="button-primary" href="/workspace">
              Open workspace <ArrowRight size={18} />
            </a>
          </section>
        </main>
        <footer className="site-footer">
          <SiteBrand />
          <p>Task planning and agent hiring on NEAR.</p>
          <nav aria-label="Footer navigation">
            <a href="#capabilities">Capabilities</a>
            <a href="/workspace">Workspace</a>
          </nav>
          <span>TASK DATA STORED LOCALLY</span>
        </footer>
      </div>
    </>
  );
}
