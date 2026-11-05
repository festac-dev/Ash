import { TRACK_IDS, type TrackId } from "../journey/core.js";

export interface TrackModuleConfig {
  id: TrackId;
  name: string;
  step: string;
  provider: string;
  live_status: "not-configured" | "requires-human-approval";
  evidence: "local-simulation";
  limitation: string;
}

export const TRACK_MODULES: Record<TrackId, TrackModuleConfig> = {
  realworld: {
    id: "realworld",
    name: "Real-World Money",
    step: "Invoice, payment link, reconciliation",
    provider: "1Click / NEAR Intents",
    live_status: "not-configured",
    evidence: "local-simulation",
    limitation: "No live 1Click quote, wallet signature or destination settlement is claimed.",
  },
  business: {
    id: "business",
    name: "Autonomous Business",
    step: "Paid sale, inference policy, revenue split",
    provider: "NEAR AI Cloud / NEAR Intents",
    live_status: "not-configured",
    evidence: "local-simulation",
    limitation: "No live inference purchase, sales settlement or treasury transfer is claimed.",
  },
  security: {
    id: "security",
    name: "AI Security & Defense",
    step: "Counterparty policy and signing boundary",
    provider: "NEAR account signals / scoped keys",
    live_status: "requires-human-approval",
    evidence: "local-simulation",
    limitation: "No live signer or on-chain counterparty data source is connected.",
  },
  privacy: {
    id: "privacy",
    name: "Privacy & Private AI",
    step: "Private expense audit and redaction",
    provider: "NEAR AI Cloud TEE",
    live_status: "not-configured",
    evidence: "local-simulation",
    limitation: "No TEE model call or fresh-nonce attestation verification is claimed.",
  },
  swarms: {
    id: "swarms",
    name: "AI Swarms",
    step: "Sealed-bid group purchase",
    provider: "NEAR sub-accounts / Intents",
    live_status: "requires-human-approval",
    evidence: "local-simulation",
    limitation: "No contracts, sub-accounts or live pooled settlement are deployed.",
  },
  social: {
    id: "social",
    name: "Social Money",
    step: "Treasury-gated bounty and reputation",
    provider: "Sputnik DAO / Trezu",
    live_status: "requires-human-approval",
    evidence: "local-simulation",
    limitation: "No Sputnik/Trezu transaction or council approval is executed.",
  },
};

export const TRACK_MODULE_LIST: TrackModuleConfig[] = TRACK_IDS.map((id) => TRACK_MODULES[id]);

export { TRACK_IDS, type TrackId };
