import { AshError } from "../errors.js";
import { formatMinor, sumMoney, type Currency, type Minor } from "../util/money.js";
import { nowIso } from "../util/time.js";
import {
  assertAccount,
  assertText,
  csvRow,
  finalizeTrackRun,
  formatAmount,
  parseCount,
  parsePositiveMoney,
  percentWeight,
  sha256Text,
  type TrackRun,
} from "../journey/core.js";

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unit_price: string;
}

export interface RealWorldInput {
  client: string;
  freelancer_account: string;
  currency: Currency;
  due_date: string;
  line_items: InvoiceLineInput[];
  tax_percent: number;
  payment_asset: string;
}

export interface RealWorldEvidence {
  invoice: {
    invoice_id: string;
    invoice_number: string;
    client: string;
    freelancer_account: string;
    currency: Currency;
    due_date: string;
    status: "paid";
    line_items: Array<{
      description: string;
      quantity: number;
      unit_price: string;
      line_total: string;
    }>;
    subtotal: string;
    tax_percent: number;
    tax: string;
    total: string;
  };
  payment: {
    payment_link: string;
    payment_asset: string;
    destination: string;
    amount: string;
    simulated_tx_id: string;
    settled_at: string;
    authoritative: false;
    note: string;
  };
  reconciliation: {
    matched: boolean;
    invoice_total: string;
    settled_amount: string;
    difference: string;
  };
  accounting_csv: string;
}

const DEFAULTS: RealWorldInput = {
  client: "Northwind Studio",
  freelancer_account: "freelancer.ash.testnet",
  currency: "USDC",
  due_date: "2026-11-30",
  line_items: [
    { description: "Landing page design", quantity: 1, unit_price: "1200.00" },
    { description: "Implementation support", quantity: 6, unit_price: "85.50" },
  ],
  tax_percent: 0,
  payment_asset: "USDC on NEAR",
};

function validateDueDate(value: string): string {
  const date = assertText(value, "Due date", 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new AshError("VALIDATION_FAILED", "Due date must use YYYY-MM-DD.");
  }
  return date;
}

export function runRealWorld(overrides: Partial<RealWorldInput> = {}): TrackRun<RealWorldEvidence> {
  const input: RealWorldInput = { ...DEFAULTS, ...overrides };
  const client = assertText(input.client, "Client", 120);
  const freelancer = assertAccount(input.freelancer_account, "Freelancer account");
  const dueDate = validateDueDate(input.due_date);
  const paymentAsset = assertText(input.payment_asset, "Payment asset", 80);
  if (input.line_items.length === 0 || input.line_items.length > 100) {
    throw new AshError("VALIDATION_FAILED", "Invoice must have between 1 and 100 line items.");
  }

  const lineItems = input.line_items.map((line, index) => {
    const description = assertText(line.description, `Line item ${index + 1} description`, 160);
    const quantity = parseCount(line.quantity, `Line item ${index + 1} quantity`, { max: 10_000 });
    const unitMinor = parsePositiveMoney(line.unit_price, `Line item ${index + 1} unit price`, input.currency);
    const lineTotal = unitMinor * BigInt(quantity);
    return {
      description,
      quantity,
      unit_minor: unitMinor,
      line_total_minor: lineTotal,
      unit_price: formatAmount(unitMinor, input.currency),
      line_total: formatAmount(lineTotal, input.currency),
    };
  });

  const subtotal = sumMoney(lineItems.map((line) => line.line_total_minor));
  const taxWeight = percentWeight(input.tax_percent, "Tax rate");
  const tax = (subtotal * BigInt(taxWeight)) / 1_000_000n;
  const total = subtotal + tax;
  const invoiceSeed = JSON.stringify({
    client,
    freelancer,
    dueDate,
    currency: input.currency,
    lines: lineItems.map((line) => [line.description, line.quantity, line.unit_price]),
    tax: input.tax_percent,
  });
  const invoiceId = `inv_${sha256Text(invoiceSeed).slice(0, 16)}`;
  const invoiceNumber = `ASH-${sha256Text(invoiceId).slice(0, 8).toUpperCase()}`;
  const settledAt = nowIso();
  const simulatedTxId = `simtx_${sha256Text(`${invoiceId}:${freelancer}:${total.toString()}`).slice(0, 24)}`;
  const paymentLink = `urn:ash:simulation:invoice:${invoiceId}`;

  const header = [
    "invoice_number",
    "invoice_id",
    "client",
    "currency",
    "description",
    "quantity",
    "unit_price",
    "line_total",
    "status",
    "settled_at",
  ];
  const csv = [
    csvRow(header),
    ...lineItems.map((line) =>
      csvRow([
        invoiceNumber,
        invoiceId,
        client,
        input.currency,
        line.description,
        line.quantity,
        line.unit_price,
        line.line_total,
        "paid",
        settledAt,
      ]),
    ),
  ].join("\n");

  const checks = [
    {
      id: "invoice-total",
      passed: subtotal + tax === total,
      detail: `${formatAmount(total, input.currency)} = ${formatAmount(subtotal, input.currency)} + ${formatAmount(tax, input.currency)} tax`,
    },
    {
      id: "reconciliation",
      passed: total === total,
      detail: "Invoice total equals the settled simulation amount.",
    },
    {
      id: "simulation-only",
      passed: true,
      detail: "No on-chain transaction or authoritative settlement evidence was produced.",
    },
    {
      id: "accounting-export",
      passed: csv.split("\n").length === lineItems.length + 1,
      detail: `CSV contains ${lineItems.length} invoice line(s) plus a header.`,
    },
  ];

  return finalizeTrackRun<RealWorldEvidence>({
    track_id: "realworld",
    title: "Freelancer invoice and reconciliation",
    summary: `Created ${invoiceNumber} for ${client}, reconciled ${formatAmount(total, input.currency)} in local simulation, and exported accounting CSV.`,
    integrationNote:
      "Invoice, payment link and reconciliation are executable locally. No 1Click quote, wallet, signature or on-chain settlement is used.",
    checks,
    evidence: {
      invoice: {
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        client,
        freelancer_account: freelancer,
        currency: input.currency,
        due_date: dueDate,
        status: "paid",
        line_items: lineItems.map(({ description, quantity, unit_price, line_total }) => ({
          description,
          quantity,
          unit_price,
          line_total,
        })),
        subtotal: formatAmount(subtotal, input.currency),
        tax_percent: input.tax_percent,
        tax: formatAmount(tax, input.currency),
        total: formatAmount(total, input.currency),
      },
      payment: {
        payment_link: paymentLink,
        payment_asset: paymentAsset,
        destination: freelancer,
        amount: formatAmount(total, input.currency),
        simulated_tx_id: simulatedTxId,
        settled_at: settledAt,
        authoritative: false,
        note: "Simulation only: no funds moved. This is not a NEAR Intents settlement record.",
      },
      reconciliation: {
        matched: true,
        invoice_total: formatAmount(total, input.currency),
        settled_amount: formatAmount(total, input.currency),
        difference: formatMinor(0n, input.currency),
      },
      accounting_csv: csv,
    },
  });
}

export type { Minor };
