# Tracked Notice Send

`send_tracked_notice` is the prospective evidentiary send path for GlacierEQ email operations.

## Identity and attribution

Each recipient receives a separate Gmail message and a separate send identity. When consented first-party pixel tracking is enabled, each recipient also receives a distinct UPORTAL publication/token binding. This prevents one recipient's engagement observation from being attributed to another recipient.

## Evidence states

The send ledger preserves distinct states:

- `TRACKER_PUBLISHED` — UPORTAL publication exists; no Gmail transmission claim yet.
- `SENT` — Gmail accepted the message and provider readback succeeded.
- `PROVIDER_ACCEPTED_READBACK_FAILED` — Gmail returned a message ID but the immediate provider readback failed. This is not recorded as a send failure.
- `SEND_FAILED` — tracker publication, MIME construction, or Gmail send failed before a verified `SENT` state.

The ledger does not equate any state above with legal service, human reading, acknowledgement, or satisfaction of a legal duty.

## Tracking modes

- `PROVIDER_STATE` — Gmail provider/correspondence evidence only.
- `EXPLICIT_RECEIPT_REQUEST` — provider state plus an explicit receipt-request posture supplied in the message content.
- `CONSENTED_FIRST_PARTY_PIXEL` — recipient-bound UPORTAL pixel only after the tracking policy confirms recipient notice/consent.

Raw UPORTAL network/device telemetry is not inserted into the tracked-send ledger. Later Notice Evidence compilation normalizes UPORTAL events under the `EVIDENCE_MINIMAL` policy.

## Automatic evidence compilation

After a tracked send reaches `SENT`, `compile_notice_evidence` can discover UPORTAL publication/token bindings from the tracked-send ledger using the Gmail thread ID. The caller does not need to re-supply tracker identifiers.

The resulting Notice Evidence Record continues to distinguish transmission, provider exceptions, engagement observations, acknowledgement, inferred human reading, formal service, and sourced duty/deadline status.
