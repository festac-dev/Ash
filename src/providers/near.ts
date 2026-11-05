import type { TrackId } from "../journey/core.js";

export type ProviderStatus = "not-configured" | "simulated-only" | "requires-human-approval";

export interface NearProviderBoundary {
  id: string;
  label: string;
  status: ProviderStatus;
  authoritative: false;
  tracks: TrackId[];
  detail: string;
}

export const NEAR_PROVIDER_BOUNDARIES: NearProviderBoundary[] = [
  {
    id: "near-1click",
    label: "1Click / NEAR Intents",
    status: "not-configured",
    authoritative: false,
    tracks: ["realworld", "business", "swarms"],
    detail: "No API credentials, quote, deposit address or mainnet funds are configured.",
  },
  {
    id: "near-ai-cloud",
    label: "NEAR AI Cloud",
    status: "not-configured",
    authoritative: false,
    tracks: ["business", "privacy"],
    detail: "No OpenAI-compatible Cloud endpoint or API key is configured.",
  },
  {
    id: "near-tee-attestation",
    label: "TEE attestation",
    status: "not-configured",
    authoritative: false,
    tracks: ["privacy"],
    detail: "No fresh nonce, attestation quote or provider verification is available.",
  },
  {
    id: "near-signer",
    label: "Scoped signer / OutLayer",
    status: "requires-human-approval",
    authoritative: false,
    tracks: ["security", "business", "swarms"],
    detail: "No wallet key, function-call key or relay account is configured.",
  },
  {
    id: "sputnik-trezu",
    label: "Sputnik DAO / Trezu",
    status: "requires-human-approval",
    authoritative: false,
    tracks: ["social"],
    detail: "No DAO or treasury account is configured for an actual proposal.",
  },
  {
    id: "near-rpc",
    label: "NEAR RPC",
    status: "not-configured",
    authoritative: false,
    tracks: ["realworld", "business", "security", "privacy", "swarms", "social"],
    detail: "No live account, contract or transaction reads are performed.",
  },
];

export function providerBoundariesFor(track: TrackId): NearProviderBoundary[] {
  return NEAR_PROVIDER_BOUNDARIES.filter((provider) => provider.tracks.includes(track));
}
