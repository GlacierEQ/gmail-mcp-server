# GlacierEQ Email Tracking Architecture

## Mission

Track operational email state with evidence-grade provenance while avoiding unnecessary recipient-side surveillance.

The core tracker is **provider-state and correspondence-state based**. It does not require an invisible tracking pixel.

## Default tracking plane

`gmail-ops-mcp` tracks and persists:

1. outbound Gmail message/thread identity;
2. provider bounce/rejection evidence;
3. recipient replies and acknowledgement language;
4. routing/referral language;
5. reference/tracking/case/request numbers supplied by the recipient;
6. assigned-office signals;
7. substantive responses;
8. received attachments/evidence;
9. response latency;
10. follow-up deadlines;
11. an append-only SHA-256 chained ledger of snapshots.

State progression:

`SENT -> DELIVERY_EXCEPTION? -> ACKNOWLEDGED -> ROUTED -> REFERENCE_NUMBER -> ASSIGNED_OFFICE -> SUBSTANTIVE_RESPONSE -> RECORDS_EVIDENCE_RECEIVED -> FOLLOW_UP_DUE?`

The states are independent observations, not a destructive single-state enum. A thread may retain several proved states simultaneously.

## Tracking modes

### PROVIDER_STATE — default

No new recipient-side telemetry primitive is inserted. Evidence comes from Gmail/provider state and the actual correspondence.

### EXPLICIT_RECEIPT_REQUEST — optional

The message visibly requests confirmation/receipt. Any returned receipt or reply is preserved as source evidence.

### CONSENTED_FIRST_PARTY_PIXEL — exceptional

Disabled unless recipient notice/consent is explicitly established. Even when enabled by policy, GlacierEQ prohibits raw IP retention, precise geolocation, device fingerprinting, cross-site identifiers, and third-party analytics pixels. The allowed telemetry is limited to an opaque message token and first-party load timestamp.

## External open-source tracker boundary

For optional controlled-link/download publication features, evaluate `mopkob1/uportal` as an **adjacent engagement plane**, not as the source of truth for delivery or legal proof. Its tracking-pixel and client/device fingerprinting features must not be enabled by default in GlacierEQ.

The forensic source of truth remains provider records + preserved correspondence + the hash-chained tracking ledger. External tracker events, if ever enabled, are supplemental observations with their own provenance and consent metadata.

## Legal-safety posture

Jurisdiction matters. Hawaii HRS Chapter 803 Part IV regulates interception/access/disclosure of electronic communications and contains party/consent exceptions. Other jurisdictions can impose materially different theories and liabilities for online tracking technologies. Accordingly, technical capability is not treated as blanket legal authorization.

Architecture rule: collect the minimum telemetry necessary to prove the operational fact being tracked, preserve provenance, and prefer provider/recipient-generated evidence over covert recipient-side instrumentation.
