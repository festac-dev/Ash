import { useState } from "react";
import { api } from "../lib/api.js";
const trackNames = {
  business: "Autonomous Business",
  swarms: "AI Swarms",
  security: "AI Security & Defense",
  agents: "Agent Economy",
  realworld: "Real-World Money",
  social: "Social Money",
};

function atomicAmount(value, decimals) {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`This asset supports ${decimals} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  return amount.toString();
}

export default function MainnetPanel({ initialAccount = "" }) {
  const [account, setAccount] = useState(initialAccount);
  const [state, setState] = useState(null);
  const [quote, setQuote] = useState(null);
  const [payment, setPayment] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verifiedTracks = evidence?.tracks.filter((track) => track.verification_status === "LIVE_VERIFIED").length ?? 0;
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mainnet-panel" aria-labelledby="mainnet-heading">
      <span className="eyebrow">NEAR MAINNET · READ ONLY</span>
      <h2 id="mainnet-heading">Check payments on NEAR.</h2>
      <p>
        Check your public wallet, preview a swap, or verify a completed token payment. These actions spend no money.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setState(null);
          setQuote(null);
          void act(async () =>
            setState(await api(`/api/mainnet/check${account ? `?account=${encodeURIComponent(account)}` : ""}`)),
          );
        }}
      >
        <label htmlFor="near-account">Public NEAR account (optional)</label>
        <input
          id="near-account"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder="yourname.near"
          maxLength={64}
        />
        <button className="button-secondary" disabled={busy}>
          {busy ? "Checking…" : "Check mainnet"}
        </button>
      </form>
      {state && (
        <p role="status">
          Mainnet connected · block {state.status.latest_block_height} · {state.supported_assets} supported assets.{" "}
          {state.account ? `Account ${state.account.account_id} exists.` : "No wallet account checked."} Check track
          evidence for payment verification.
        </p>
      )}
      <button
        className="button-secondary"
        disabled={busy}
        onClick={() => void act(async () => setEvidence(await api("/api/mainnet/evidence")))}
      >
        Check track evidence
      </button>
      {evidence && (
        <div className="mainnet-evidence">
          <h3>Track evidence</h3>
          <p className="mainnet-evidence-summary" role="status">
            {evidence.all_six_live_verified
              ? "All six track checks passed. See each check's scope below."
              : `${verifiedTracks} of ${evidence.tracks.length} track checks have verified evidence.`}
          </p>
          <table aria-label="Live track evidence" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">
                  Track
                </th>
                <th scope="col" role="columnheader">
                  Verification
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {evidence.tracks.map((track) => (
                <tr key={track.id} role="row">
                  <td role="cell">
                    <strong>{trackNames[track.id] ?? track.id}</strong>
                    <p>{track.scope}</p>
                  </td>
                  <td role="cell">
                    <span
                      className={`mainnet-verdict ${track.verification_status === "UNVERIFIED" ? "mainnet-verdict-pending" : ""}`}
                    >
                      {track.verification_status === "LIVE_VERIFIED"
                        ? "Verified"
                        : track.verification_status === "UNVERIFIED"
                          ? "Unverified"
                          : track.verification_status.replaceAll("_", " ")}
                    </span>
                    {track.missing && <p>{track.missing}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setQuote(null);
            const form = new FormData(event.currentTarget);
            void act(async () => {
              const origin = state.assets.find((asset) => asset.assetId === form.get("origin"));
              setQuote(
                await api("/api/mainnet/quote", {
                  method: "POST",
                  body: {
                    origin_asset: origin.assetId,
                    destination_asset: form.get("destination"),
                    amount_atomic: atomicAmount(String(form.get("amount")), origin.decimals),
                    refund_to: form.get("refund"),
                    recipient: form.get("recipient"),
                    slippage_bps: 50,
                  },
                }),
              );
            });
          }}
        >
          <h3>Preview a swap</h3>
          <label htmlFor="near-origin">Pay with</label>
          <select id="near-origin" name="origin" required>
            {state.assets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.symbol} · {asset.blockchain} · {asset.assetId}
              </option>
            ))}
          </select>
          <label htmlFor="near-destination">Receive on NEAR</label>
          <select id="near-destination" name="destination" required>
            {state.near_assets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.symbol} · {asset.assetId}
              </option>
            ))}
          </select>
          <label htmlFor="near-amount">Amount to pay</label>
          <input id="near-amount" name="amount" required inputMode="decimal" maxLength={80} />
          <label htmlFor="near-refund">Refund wallet on the paying chain</label>
          <input id="near-refund" name="refund" required defaultValue={account} maxLength={200} />
          <label htmlFor="near-recipient">Recipient NEAR account</label>
          <input id="near-recipient" name="recipient" required defaultValue={account} maxLength={64} />
          <button className="button-secondary" disabled={busy}>
            Get dry quote
          </button>
        </form>
      )}
      {quote && (
        <p role="status">
          Dry quote received. Expected output: {quote.quote.amountOut} atomic units; minimum {quote.quote.minAmountOut}.
          No deposit address was created and nothing was paid.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setPayment(null);
          const form = new FormData(event.currentTarget);
          void act(async () =>
            setPayment(
              await api("/api/mainnet/preview", {
                method: "POST",
                body: {
                  transfer: {
                    tx_hash: form.get("hash"),
                    signer_account: form.get("signer"),
                    sender_account: form.get("sender"),
                    recipient_account: form.get("recipient"),
                    token_account: form.get("token"),
                    amount_atomic: form.get("atomic"),
                  },
                },
              }),
            ),
          );
        }}
      >
        <h3>Verify a completed payment</h3>
        <p>This checks the transfer without saving it or assigning it to an invoice, job or bounty.</p>
        {[
          ["hash", "NEAR transaction hash", 44],
          ["signer", "Transaction signer account", 64],
          ["sender", "Token sender account", 64],
          ["recipient", "Token recipient account", 64],
          ["token", "NEAR token contract", 64],
          ["atomic", "Exact amount in atomic units", 78],
        ].map(([name, label, maxLength]) => (
          <div key={name}>
            <label htmlFor={`near-proof-${name}`}>{label}</label>
            <input id={`near-proof-${name}`} name={name} required maxLength={maxLength} />
          </div>
        ))}
        <button className="button-secondary" disabled={busy}>
          Verify transfer
        </button>
      </form>
      {payment && (
        <p role="status">
          Verified final token transfer {payment.verification.expected.tx_hash}. Nothing was saved or assigned to a
          payment.
        </p>
      )}
    </section>
  );
}
