# Transactions and receipts

Each finalized subtask attempt produces at most one JSON receipt per task/subtask, including unpaid DIY work, rejected deliverables, started cancelled jobs, failed jobs and walked-away negotiations. Unstarted cancelled or dependency-blocked work may have no receipt; its task state records why it did not run. Receipts are individual files in:

```
$ASH_DATA_DIR/transactions/
```

The folder is created automatically when the first receipt is written. Merely running `verify` on an empty installation does not create it.

## Filenames

```
Ash_YYYYMMDD_HHMM.json
```

The timestamp is UTC. If another receipt already exists in that minute, Ash appends a collision suffix:

```
Ash_20261103_0918.json
Ash_20261103_0918_2.json
Ash_20261103_0918_3.json
```

The writer uses atomic exclusive creation. It never overwrites an existing receipt. A filename whose timestamp does not match its UTC minute is reported as an integrity failure.

## Receipt schema (version 1.0)

```json
{
  "schema_version": "1.0",
  "transaction_id": "txn_mw0gglal_761fbffe5785",
  "sequence": 1,
  "idempotency_key": "task_20261103T085754_3508ed:st_1",
  "task_id": "task_20261103T085754_3508ed",
  "subtask_id": "st_1",
  "task_description": "Build a production-ready website...",
  "item": "Architecture and scope",
  "subtask_description": "Define scope, constraints and an implementation approach...",
  "status": "UNPAID",
  "vendor": null,
  "planned_max": "0.00",
  "quoted_price": null,
  "negotiated_price": null,
  "agreed_price": null,
  "currency": "USDC",
  "marketplace_job_id": null,
  "payment_status": "NOT_PAID",
  "check_result": {
    "passed": true,
    "status": "passed",
    "details": "All acceptance criteria passed.",
    "criteria": [
      {
        "criterion": "The deliverable is present.",
        "kind": "deliverable_present",
        "passed": true,
        "details": "Deliverable has 1044 characters; at least 180 required."
      }
    ],
    "injection_flags": []
  },
  "negotiation_log": [],
  "approval_ref": null,
  "timestamp": "2026-11-03T08:58:12.813Z",
  "previous_hash": "GENESIS",
  "hash_algorithm": "SHA-256",
  "hash": "f3e782982ed66b35cdb1e5e8e54a689c5b9c42e91b1f8234cf9d2b2a182d3800",
  "mode": "simulated",
  "attempt": 1,
  "metadata": {
    "reason": "DIY deliverable passed all acceptance criteria.",
    "job_id": "",
    "deliverable": "tasks/task_.../deliverables/st_1/attempt-1.md",
    "file": "Ash_20261103_0858.json"
  }
}
```

Field notes:

- `status` is one of `PAID`, `SIMULATED`, `UNPAID`, `REJECTED`, `FAILED`, `WALKED_AWAY`, `CANCELLED`.
- `payment_status` is one of `RELEASED`, `SIMULATED_RELEASED`, `NOT_PAID`, `ESCROWED`, `REFUNDED`, `REFUND_PENDING`, `AWAITING_HUMAN_ACCEPTANCE`.
- `mode` distinguishes live from simulation. Every simulation receipt says `SIMULATED` or carries `mode: "simulated"`.
- Amount fields are decimal strings with at most six decimal places. Internal math uses integer minor units.
- `attempt` is the subtask attempt number, including the one revision round.
- `metadata.file` is the receipt filename and is included in the hash.

## Hashing

Ash follows a deterministic procedure:

1. Build and schema-normalize the complete persisted receipt, including the previous verified hash (or `GENESIS`), algorithm, sequence and filename metadata.
2. Canonicalize it without `hash`: sort object keys recursively, preserve array order, omit undefined fields and reject non-finite numbers.
3. Compute SHA-256 over the canonical UTF-8 bytes and store its lowercase hexadecimal digest in `hash`.
4. Verify the final receipt, durably journal the append, exclusively create the receipt, update the chain head, then clear the journal.

A wall clock older than the latest receipt timestamp is rejected before an append is written. Restore a correct system clock and retry; existing receipts are never reordered.

`hash` is excluded from its own input. `previous_hash`, `hash_algorithm`, `schema_version`, amounts and metadata are included.

The canonical function is in `src/util/json.ts`; the receipt functions are in `src/transactions/ledger.ts`.

## Chain head witness

In addition to the receipt files, Ash writes `.chain-head.json`:

```json
{
  "schema_version": 1,
  "count": 7,
  "last_hash": "...",
  "last_file": "Ash_20261103_0908.json",
  "updated_at": "2026-11-03T09:10:10.000Z"
}
```

It is not a signed receipt. Its purpose is to detect deletion of the newest receipt: the receipt chain alone cannot notice that its tail disappeared. A stale chain head is completed only when a matching durable append journal proves the interrupted write; an unexplained mismatch is an error; a head that claims **more** receipts than exist is an error; a corrupt head is an error because tail deletion can no longer be ruled out. The chain head is a local witness, not an external anchor: an attacker who rewrites the entire chain and head consistently is not detectable by this mechanism alone. Use an external signed checkpoint if that threat matters.

## Idempotency and crash safety

- The receipt idempotency key is `task_id:subtask_id`, so a retry after a crash returns the existing receipt instead of creating a second one.
- The writer holds a lock on the transactions directory and verifies the existing chain before appending. It refuses to append to a broken chain.
- Before creating a receipt, the writer atomically saves `.pending-append.json` with the full hashed receipt and previous chain-head witness. It then exclusively creates the receipt, atomically updates the head, and clears the journal.
- Readers and writers share the transaction lock. On restart they finish a journaled append only after checking the complete chain, receipt hash, filename, sequence and old/new witness. Replays return the original transaction id.
- Recovery refuses altered records, unexplained head mismatches and missing receipts already covered by the committed head. It does not reconstruct an interrupted append from older versions that had no journal; those require the original witness/receipts to be restored.
- Ledger releases/refunds check for an existing entry for the same job reference, so a retry cannot pay twice.
- Marketplace hires use a persisted `client_request_id`, which the market deduplicates.

## Verification

```bash
ash verify
```

or inside the app:

```
╭─[ASH]─[IDLE]
╰─❯ verify
```

The checker reads every `Ash_*.json` file and reports:

| Code | Meaning |
|---|---|
| `PARSE_ERROR` | File is not valid JSON |
| `SCHEMA_INVALID` | Missing/invalid field or unsupported schema version |
| `HASH_MISMATCH` | Receipt contents changed after hashing |
| `BROKEN_CHAIN` | `previous_hash` does not match the previous receipt |
| `GENESIS_INVALID` | First receipt does not use `previous_hash: "GENESIS"` |
| `SEQUENCE_GAP` | Missing/out-of-order sequence number |
| `DUPLICATE_TRANSACTION_ID` | Same transaction id in two receipts |
| `DUPLICATE_IDEMPOTENCY_KEY` | Same task/subtask receipt twice |
| `FILENAME_MISMATCH` | Filename minute does not match the UTC timestamp |
| `MISSING_RECEIPT` | Chain head records more receipts than are present |
| `CHAIN_HEAD_MISMATCH` | Head hash is not the final receipt hash |
| `UNKNOWN_FILE` | Extra file is not part of the chain (warning) |

The report names the exact file for every failure. Ash **never silently repairs, rewrites or deletes** a receipt. If the directory is missing, `verify` reports an empty, valid ledger and does not create it.

## Status examples

| Situation | `status` | `payment_status` |
|---|---|---|
| DIY deliverable passed | `UNPAID` | `NOT_PAID` |
| Paid marketplace job, market confirmed completed | `PAID` | `RELEASED` |
| Same in simulation | `SIMULATED` | `SIMULATED_RELEASED` |
| Deliverable rejected after revision, escrow still held | `REJECTED` | `ESCROWED` |
| Job cancelled, refund not confirmed | `CANCELLED` | `REFUND_PENDING` |
| No affordable/suitable agent | `WALKED_AWAY` | `NOT_PAID` |
| Technical failure before any funding | `FAILED` | `NOT_PAID` |
| Market auto-accepted before Ash verification | `REJECTED` | `RELEASED` |

## Schema evolution

Receipts are versioned with `schema_version`. The reader accepts version `1.0` and preserves unknown fields (the schema is passthrough), so adding fields does not break old records. A future incompatible version must be introduced with a migration path; Ash refuses to guess at an unsupported version. The hash covers unknown fields too, so old records remain verifiable.
