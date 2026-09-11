export type TrackingMode =
  | 'PROVIDER_STATE'
  | 'EXPLICIT_RECEIPT_REQUEST'
  | 'CONSENTED_FIRST_PARTY_PIXEL';

export interface TrackingPolicyDecision {
  mode: TrackingMode;
  allowed: boolean;
  requiresRecipientNotice: boolean;
  permittedData: string[];
  prohibitedData: string[];
  rationale: string;
}

/**
 * GlacierEQ default: prove what the mail provider and the correspondence itself can prove.
 * No covert pixel, fingerprinting, geolocation enrichment, or third-party behavioral profiling.
 *
 * A consented first-party pixel is available only as an explicit opt-in mode and is deliberately
 * constrained to a timestamp + opaque message token. Legal requirements vary by recipient
 * jurisdiction; this function is a technical policy gate, not a legal opinion.
 */
export function evaluateTrackingMode(
  mode: TrackingMode,
  recipientNoticeOrConsent = false,
): TrackingPolicyDecision {
  if (mode === 'PROVIDER_STATE') {
    return {
      mode,
      allowed: true,
      requiresRecipientNotice: false,
      permittedData: [
        'gmail message id',
        'gmail thread id',
        'sent timestamp',
        'provider bounce/rejection notice',
        'recipient reply timestamp',
        'recipient-supplied acknowledgement',
        'recipient-supplied reference number',
        'recipient-supplied routing/assignment information',
      ],
      prohibitedData: ['covert IP collection', 'device fingerprinting', 'third-party behavioral profiling'],
      rationale: 'Uses provider/account state and the correspondence itself; no recipient-side surveillance primitive is added.',
    };
  }

  if (mode === 'EXPLICIT_RECEIPT_REQUEST') {
    return {
      mode,
      allowed: true,
      requiresRecipientNotice: true,
      permittedData: ['recipient-visible receipt request', 'recipient-generated receipt or reply', 'provider identifiers and timestamps'],
      prohibitedData: ['covert IP collection', 'device fingerprinting', 'third-party behavioral profiling'],
      rationale: 'Tracking is disclosed in the message flow and evidence comes from the recipient or provider.',
    };
  }

  return {
    mode,
    allowed: recipientNoticeOrConsent,
    requiresRecipientNotice: true,
    permittedData: recipientNoticeOrConsent ? ['opaque message token', 'first-party pixel-load timestamp'] : [],
    prohibitedData: ['raw IP retention', 'precise geolocation', 'device fingerprinting', 'cross-site identifiers', 'third-party analytics pixels'],
    rationale: recipientNoticeOrConsent
      ? 'First-party open telemetry is permitted by this technical gate only after explicit notice/consent; jurisdiction-specific legal review still applies.'
      : 'Refused: recipient notice/consent was not established.',
  };
}
