import path from "node:path";
import { atomicWriteJson, ensurePrivateDir } from "../util/fs.js";
import { newId } from "../util/ids.js";
import { hashJson } from "../util/json.js";
import { nowIso } from "../util/time.js";
import { errorMessage } from "../errors.js";
import { TRACK_IDS, allChecksPass, isTrackId, type TrackCheck, type TrackId, type TrackRun } from "./core.js";
import { AshError } from "../errors.js";
import { runBusiness } from "../steps/business.js";
import { runPrivacy } from "../steps/privacy.js";
import { runRealWorld } from "../steps/realworld.js";
import { runSecurity } from "../steps/security.js";
import { runSocial } from "../steps/social.js";
import { runSwarms } from "../steps/swarms.js";

export * from "./core.js";

export const TRACK_RUNNERS: Record<TrackId, () => TrackRun<unknown>> = {
  realworld: runRealWorld,
  business: runBusiness,
  security: runSecurity,
  privacy: runPrivacy,
  swarms: runSwarms,
  social: runSocial,
};

export function runTrack(id: string): TrackRun<unknown> {
  const normalized = id.trim().toLowerCase();
  if (!isTrackId(normalized)) {
    throw new AshError("NOT_FOUND", `Unknown track "${id}". Choose one of: ${TRACK_IDS.join(", ")}.`);
  }
  return TRACK_RUNNERS[normalized]();
}

export function runAllTracks(): TrackRun<unknown>[] {
  return TRACK_IDS.map((id) => TRACK_RUNNERS[id]());
}

export interface JourneyStep {
  track_id: TrackId;
  title: string;
  status: "PASS" | "FAIL";
  summary: string;
  evidence_sha256: string | null;
  checks: TrackCheck[];
  error: string | null;
}

export interface TrackJourney {
  schema_version: 1;
  journey_id: string;
  mode: "SIMULATION";
  created_at: string;
  all_passed: boolean;
  passed: number;
  failed: number;
  steps: JourneyStep[];
  integration_note: string;
  journey_sha256: string;
}

function stepFromRun(run: TrackRun<unknown>): JourneyStep {
  const failed = run.checks.filter((check) => !check.passed);
  return {
    track_id: run.track_id,
    title: run.title,
    status: failed.length === 0 ? "PASS" : "FAIL",
    summary: run.summary,
    evidence_sha256: run.evidence_sha256,
    checks: run.checks,
    error: null,
  };
}

function stepFromError(trackId: TrackId, title: string, error: unknown): JourneyStep {
  return {
    track_id: trackId,
    title,
    status: "FAIL",
    summary: "The local workflow did not complete.",
    evidence_sha256: null,
    checks: [],
    error: errorMessage(error),
  };
}

export function runJourney(): TrackJourney {
  const steps: JourneyStep[] = [];
  let realworld: TrackRun<unknown> | null = null;
  try {
    realworld = runRealWorld({
      client: "Northwind Studio",
      freelancer_account: "ash-freelancer.testnet",
      line_items: [
        { description: "Community dashboard design", quantity: 1, unit_price: "1200.00" },
        { description: "Implementation support", quantity: 6, unit_price: "115.00" },
      ],
      due_date: "2026-11-30",
      payment_asset: "USDC on NEAR",
    });
    steps.push(stepFromRun(realworld));
  } catch (error) {
    steps.push(stepFromError("realworld", "Freelancer invoice and reconciliation", error));
  }

  const invoiceAmount =
    realworld?.evidence && typeof realworld.evidence === "object" && "invoice" in realworld.evidence
      ? String((realworld.evidence as { invoice: { total: string } }).invoice.total)
      : "1890.00";

  try {
    steps.push(
      stepFromRun(
        runSecurity({
          allowed_case: {
            counterparty: "northwind-studio.testnet",
            amount: invoiceAmount,
            currency: "USDC",
            signals: {
              verified: true,
              account_age_days: 420,
              allowlisted: true,
              contract_allowlisted: true,
              sanctions_hit: false,
              report_count: 0,
            },
          },
          policy: {
            min_account_age_days: 30,
            high_value_threshold: "5000.00",
            fail_mode: "BLOCK",
            contract_allowlist: ["ash-payments.testnet"],
          },
        }),
      ),
    );
  } catch (error) {
    steps.push(stepFromError("security", "Counterparty policy and signing boundary", error));
  }

  let business: TrackRun<unknown> | null = null;
  try {
    business = runBusiness({
      treasury_account: "ash-treasury.testnet",
      sale_amount: invoiceAmount,
      currency: "USDC",
      sale_paid: true,
      daily_inference_limit: "20.00",
      inference_spend: "6.50",
    });
    steps.push(stepFromRun(business));
  } catch (error) {
    steps.push(stepFromError("business", "Autonomous business revenue and inference policy", error));
  }

  try {
    steps.push(
      stepFromRun(
        runSwarms({
          seed: "ash-journey-2026",
          product: "H100 GPU hour",
          buyer_count: 20,
          seller_count: 5,
          quantity_per_buyer: 1,
          max_unit_price: "2.50",
        }),
      ),
    );
  } catch (error) {
    steps.push(stepFromError("swarms", "Sealed-bid group purchase", error));
  }

  try {
    steps.push(
      stepFromRun(
        runPrivacy({
          document_name: "northwind-expenses.txt",
          high_value_threshold: "100.00",
        }),
      ),
    );
  } catch (error) {
    steps.push(stepFromError("privacy", "Private expense audit with no-retention evidence", error));
  }

  const contributorAmount =
    business?.evidence && typeof business.evidence === "object" && "contributor_payouts" in business.evidence
      ? ((business.evidence as { contributor_payouts: Array<{ amount: string }> }).contributor_payouts[0]?.amount ??
        "75.00")
      : "75.00";
  try {
    steps.push(
      stepFromRun(
        runSocial({
          bounty_title: "Ship the community dashboard",
          amount: contributorAmount,
          treasury_type: "sputnik",
          treasury_account: "community.sputnik-dao.near",
          required_approvals: 2,
          approvals: [
            { account: "alice.sputnik-dao.near", approved: true },
            { account: "bob.sputnik-dao.near", approved: true },
          ],
        }),
      ),
    );
  } catch (error) {
    steps.push(stepFromError("social", "Treasury-gated bounty and reputation", error));
  }

  const passed = steps.filter((step) => step.status === "PASS").length;
  const failed = steps.length - passed;
  const draft = {
    schema_version: 1 as const,
    journey_id: newId("journey"),
    mode: "SIMULATION" as const,
    created_at: nowIso(),
    all_passed: failed === 0,
    passed,
    failed,
    steps,
    integration_note:
      "All six modules run locally from deterministic fixtures. No NEAR contract, Intents quote, wallet key, treasury, TEE model or on-chain settlement is used.",
  };
  return { ...draft, journey_sha256: hashJson({ ...draft, journey_sha256: undefined }) };
}

export async function persistJourney(dataDir: string, journey: TrackJourney): Promise<string> {
  const dir = path.join(dataDir, "journeys");
  await ensurePrivateDir(dir);
  const file = path.join(dir, `${journey.journey_id}.json`);
  await atomicWriteJson(file, journey);
  return file;
}
