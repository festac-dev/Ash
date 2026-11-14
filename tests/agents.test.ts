import assert from "node:assert/strict";
import test from "node:test";
import { runAgentEconomy } from "../src/steps/agents.js";
import { HACKATHON_TRACK_IDS, TRACK_IDS, assertAccount } from "../src/journey/core.js";
import { getScope, validateScopeInputs } from "../src/tracks.js";

test("every requested official track has a scope and a runnable module", () => {
  assert.deepEqual(HACKATHON_TRACK_IDS, ["business", "swarms", "security", "agents", "realworld", "social"]);
  for (const id of HACKATHON_TRACK_IDS) {
    assert.ok(TRACK_IDS.includes(id));
    assert.ok(getScope(id));
  }
  const scope = getScope("agents")!;
  assert.deepEqual(
    validateScopeInputs(scope, {
      agent_account: "agent.near",
      spending_limit: "1.00",
      payment_asset: "USDC on NEAR",
      kill_switch: "Owner stops all new work",
    }),
    [],
  );
  assert.ok(validateScopeInputs(scope, { agent_account: "a" }).length > 0);
  assert.throws(() => assertAccount("a", "Account"));
});

test("agent commerce conserves money and negotiates an affordable specialist", () => {
  const { evidence, checks } = runAgentEconomy();
  assert.equal(evidence.hired, "researcher.ash.testnet");
  assert.deepEqual(evidence.wallet, { opening: "10.00", earned: "25.00", spent: "9.50", remaining: "25.50" });
  assert.equal(evidence.receipts.length, 3);
  assert.equal(evidence.duplicate_payment_blocked, true);
  assert.ok(checks.every((check) => check.passed));
});

test("agent hiring refuses missing approval, killed spending and unverified work", () => {
  assert.throws(() => runAgentEconomy({ approved: false }), /approval/);
  assert.throws(() => runAgentEconomy({ killed: true }), /kill switch/);
  assert.throws(
    () =>
      runAgentEconomy({ offers: [{ account: "seller.near", ask: "1.00", minimum: "1.00", verified_delivery: false }] }),
    /Unverified/,
  );
});

test("agent hiring counts API costs against both budget and balance", () => {
  assert.throws(() => runAgentEconomy({ budget: "9.00" }), /budget/);
  assert.throws(() => runAgentEconomy({ opening_balance: "0", earned: "1.00" }), /wallet balance/);
  const { evidence } = runAgentEconomy({
    opening_balance: "0",
    earned: "0.000003",
    budget: "0.000003",
    api_cost: "0.000001",
    offers: [{ account: "seller.near", ask: "0.000002", minimum: "0.000002", verified_delivery: true }],
  });
  assert.equal(evidence.wallet.remaining, "0.00");
  assert.equal(evidence.wallet.spent, "0.000003");
});

test("agent offers reject self-hiring, duplicates and impossible minimums", () => {
  assert.throws(() => runAgentEconomy({ offers: [] }), /one and twenty/);
  assert.throws(
    () =>
      runAgentEconomy({
        offers: [{ account: "operator.ash.testnet", ask: "1", minimum: "1", verified_delivery: true }],
      }),
    /distinct/,
  );
  assert.throws(
    () => runAgentEconomy({ offers: [{ account: "seller.near", ask: "1", minimum: "2", verified_delivery: true }] }),
    /minimum/,
  );
});
