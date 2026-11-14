import { TRACK_IDS, type TrackId } from "../journey/core.js";

export interface TrackModuleConfig {
  id: TrackId;
  name: string;
  step: string;
  provider: string;
  live_status: "not-configured" | "requires-human-approval" | "implemented";
  evidence: "local-simulation";
  limitation: string;
}

export const TRACK_MODULES: Record<TrackId, TrackModuleConfig> = {
  realworld: {
    id: "realworld",
    name: "Real-World Money",
    step: "Invoice creation and token reconciliation",
    provider: "1Click / NEAR Intents",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Live invoice creation, dry 1Click quotes and final token settlement are implemented. No paid invoice is assumed without its exact final transfer proof.",
  },
  business: {
    id: "business",
    name: "Autonomous Business",
    step: "Paid sale, inference policy, revenue split",
    provider: "Model provider / NEAR token payments",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Verified-sale revenue allocation and capped native/wrapped NEAR payouts are implemented. No inference purchase is assumed without provider credentials and evidence.",
  },
  security: {
    id: "security",
    name: "AI Security & Defense",
    step: "Counterparty policy and signing boundary",
    provider: "NEAR account signals / operator policy",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Live key/account checks and the opt-in CLI signer enforce recipient and spending policy. No external counterparty risk feed or on-chain fee cap is claimed.",
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
    step: "Committed-bid validation and allocation",
    provider: "NEAR token pool / trusted coordinator",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Live pool funding, bid selection, reservations and exact payout reconciliation are implemented. No atomic escrow contract or agent sub-account deployment is claimed.",
  },
  agents: {
    id: "agents",
    name: "Agent Economy",
    step: "Earn, negotiate, hire and pay for APIs",
    provider: "NEAR Agent Market / token accounting",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Agent Market hiring, verified earnings and capped native/wrapped NEAR signing are integrated. No API purchase or delivery is assumed without provider evidence.",
  },
  social: {
    id: "social",
    name: "Social Money",
    step: "Treasury-gated bounty and reputation",
    provider: "Sputnik DAO",
    live_status: "implemented",
    evidence: "local-simulation",
    limitation:
      "Approved Sputnik token proposals bind exact final payouts and durable reputation. No Trezu execution or public bounty-board deployment is claimed.",
  },
};

export const TRACK_MODULE_LIST: TrackModuleConfig[] = TRACK_IDS.map((id) => TRACK_MODULES[id]);

export { TRACK_IDS, type TrackId };
