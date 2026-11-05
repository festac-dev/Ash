import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Fingerprint,
  Moon,
  Network,
  ShieldCheck,
  Sun,
  Wallet,
} from "lucide-react";
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
                <span className="tiny-square" /> THE ASH NETWORK
              </span>
              <span className="hero-environment">
                {simulated ? "SIMULATION · NO REAL FUNDS" : "YOUR NEXT IDEA STARTS HERE"}
                <span className="tiny-cross">+</span>
              </span>
            </div>
            <div className="hero-layout">
              <div className="hero-copy">
                <div className="eyebrow">
                  <span className="eyebrow-dash" /> AUTONOMY, WITH ACCOUNTABILITY
                </div>
                <h1 id="hero-heading">
                  Intelligence
                  <br />
                  that <span>executes.</span>
                </h1>
                <p className="hero-description">Your idea. A clear plan. Verified work.</p>
                <div className="hero-actions">
                  <a className="button-primary" href="/workspace">
                    Enter your workspace <ArrowUpRight size={18} />
                  </a>
                  <button className="button-text" onClick={() => setAbout(true)}>
                    <span className="play-outline">▷</span> How ASH works
                  </button>
                </div>
                <div className="hero-assurances">
                  <span>
                    <ShieldCheck size={14} />
                    You set the limits
                  </span>
                  <span>
                    <Fingerprint size={14} />
                    ASH leaves the proof
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
            <div className="hero-bottomline">
              <span>
                <span className="status-dot" /> Ambient visualization
              </span>
              <a href="#capabilities">
                EXPLORE ASH <ArrowDown size={13} />
              </a>
              <span>BUILT FOR VERIFIABLE WORK</span>
            </div>
          </section>
          <section id="capabilities" className="capabilities-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">DESIGNED FOR REAL WORK</span>
                <h2>Autonomous. Never unaccountable.</h2>
              </div>
              <p>
                A clear plan. Explicit limits.
                <br />
                Results you can inspect.
              </p>
            </div>
            <div className="feature-grid">
              {[
                {
                  Icon: Network,
                  no: "01",
                  title: "Agents, working together.",
                  description: "Find the right agents for the work.",
                },
                {
                  Icon: Wallet,
                  no: "02",
                  title: "Your budget. Your rules.",
                  description: "Set limits. Approve the plan.",
                },
                {
                  Icon: Fingerprint,
                  no: "03",
                  title: "Proof over promises.",
                  description: "Every attempt leaves a receipt.",
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
              <span className="eyebrow">TURN INTENT INTO OUTCOME</span>
              <h2>Your next move, connected.</h2>
            </div>
            <a className="button-primary" href="/workspace">
              Open workspace <ArrowRight size={18} />
            </a>
          </section>
        </main>
        <footer className="site-footer">
          <SiteBrand />
          <p>Intelligence that executes.</p>
          <nav aria-label="Footer navigation">
            <a href="#capabilities">Capabilities</a>
            <a href="/workspace">Workspace</a>
          </nav>
          <span>LOCAL-FIRST. HUMAN-GOVERNED.</span>
        </footer>
      </div>
    </>
  );
}
