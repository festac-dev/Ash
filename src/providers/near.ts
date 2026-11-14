import type { TrackId } from "../journey/core.js";

export type ProviderStatus =
  "not-configured" | "simulated-only" | "requires-human-approval" | "read-only-implemented" | "opt-in-implemented";

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
    status: "read-only-implemented",
    authoritative: false,
    tracks: ["realworld", "business", "swarms", "agents"],
    detail:
      "Live token discovery and dry quotes are implemented. No deposit address, funding or signed intent is created; paid settlement remains unverified.",
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
    label: "Operator CLI signer",
    status: "opt-in-implemented",
    authoritative: false,
    tracks: ["security", "business", "swarms", "agents"],
    detail:
      "Opt-in native/wrapped NEAR signing uses local ed25519 keys, recipient policy and cumulative value/gas reservations. No signing API or OutLayer relayer is claimed.",
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
    status: "read-only-implemented",
    authoritative: false,
    tracks: ["realworld", "business", "security", "privacy", "swarms", "agents", "social"],
    detail:
      "Mainnet status, final account/access-key reads, Sputnik proposal reads and exact NEP-141 transaction verification are implemented. Connectivity is separate from paid workflow evidence.",
  },
];

export function providerBoundariesFor(track: TrackId): NearProviderBoundary[] {
  return NEAR_PROVIDER_BOUNDARIES.filter((provider) => provider.tracks.includes(track));
}
