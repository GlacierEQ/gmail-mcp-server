import crypto from 'crypto';
import { EmailOperationalSnapshot } from './email-operations-pipeline.js';

export type UportalEventType = 'open' | 'click' | 'page_view' | 'content' | 'download' | 'pixel';
export type EvidenceTruthState = 'ESTABLISHED' | 'OBSERVED' | 'SUPPORTED' | 'CONTRADICTED' | 'NOT_OBSERVED' | 'NOT_ESTABLISHED';

export interface EngagementObservation {
  schema: 'glaciereq.engagement-observation.v1';
  source: 'uportal';
  observedAt: string;
  event: UportalEventType;
  publicationId: string;
  token?: string;
  publicationType?: string;
  shortId?: string;
  subject?: string;
  recipients: string[];
  actor?: string;
  owner?: string;
  createdBy?: string;
  publishedAt?: string;
  sourceFile?: { sequence?: number; name?: string };
  counter?: { decremented?: boolean; remainingBefore?: string; remainingAfter?: string };
  privacy: {
    retainedFields: string[];
    discardedSensitiveFields: string[];
    policy: 'EVIDENCE_MINIMAL';
  };
  sourcePayloadSha256: string;
  evidenceSha256: string;
}

export interface EvidenceAssertion {
  proposition: string;
  truthState: EvidenceTruthState;
  basis: string[];
  caution?: string;
}

export type DutyTrigger = 'SENT' | 'ACKNOWLEDGED' | 'ENGAGEMENT' | 'EXPLICIT';
export type DutySatisfaction = 'ANY_INBOUND' | 'ACKNOWLEDGEMENT' | 'SUBSTANTIVE_RESPONSE' | 'RECORDS_EVIDENCE_RECEIVED' | 'EXPLICIT';
export type DeadlineUnit = 'HOURS' | 'CALENDAR_DAYS' | 'BUSINESS_DAYS';

export interface DutySpec {
  id: string;
  authority: {
    label: string;
    citation: string;
    jurisdiction?: string;
    sourceUrl?: string;
  };
  requiredAction: string;
  trigger: DutyTrigger;
  explicitTriggerAt?: string;
  deadline: {
    unit: DeadlineUnit;
    value: number;
    holidays?: string[];
  };
  satisfaction: DutySatisfaction;
  explicitSatisfiedAt?: string;
}

export interface DutyAssessment {
  schema: 'glaciereq.notice-duty-assessment.v1';
  dutyId: string;
  authority: DutySpec['authority'];
  requiredAction: string;
  trigger: DutyTrigger;
  satisfactionRule: DutySatisfaction;
  status: 'NOT_TRIGGERED' | 'PENDING' | 'SATISFIED' | 'OVERDUE';
  triggerAt?: string;
  dueAt?: string;
  satisfiedAt?: string;
  evidenceBasis: string[];
  assessmentCaution: string;
}

export interface NoticeEvidenceRecord {
  schema: 'glaciereq.notice-evidence.v1';
  generatedAt: string;
  threadId: string;
  normalizedSubject: string;
  participants: string[];
  gmailEvidenceDigestSha256: string;
  gmailSnapshot: EmailOperationalSnapshot;
  engagementObservations: EngagementObservation[];
  assertions: EvidenceAssertion[];
  dutyAssessment?: DutyAssessment;
  recordDigestSha256: string;
}

const UPORTAL_EVENTS = new Set<UportalEventType>(['open', 'click', 'page_view', 'content', 'download', 'pixel']);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map(v => v.trim()) : [];
}

function validIso(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Convert a UPORTAL raw event into an evidentiary observation without carrying
 * forward network identifiers or device-fingerprinting telemetry. The complete
 * source event is integrity-bound by SHA-256, while only the first-party facts
 * needed to prove publication access are retained.
 */
export function normalizeUportalEvent(raw: Record<string, unknown>): EngagementObservation {
  const event = stringValue(raw.event) as UportalEventType | undefined;
  if (!event || !UPORTAL_EVENTS.has(event)) throw new Error(`Unsupported UPORTAL event: ${String(raw.event)}`);

  const publicationId = stringValue(raw.publication) || stringValue(raw.publication_id);
  if (!publicationId) throw new Error('UPORTAL event is missing publication id');

  const observedAt = validIso(raw.ts) || validIso(raw.timestamp) || validIso(raw.at);
  if (!observedAt) throw new Error('UPORTAL event is missing a valid timestamp');

  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta as Record<string, unknown> : {};
  const file = raw.file && typeof raw.file === 'object' ? raw.file as Record<string, unknown> : {};
  const counter = raw.counter && typeof raw.counter === 'object' ? raw.counter as Record<string, unknown> : {};
  const request = raw.request && typeof raw.request === 'object' ? raw.request as Record<string, unknown> : {};
  const deviceGuess = raw.device_guess && typeof raw.device_guess === 'object' ? raw.device_guess as Record<string, unknown> : {};
  const cookies = raw.cookies && typeof raw.cookies === 'object' ? raw.cookies as Record<string, unknown> : {};

  const discarded: string[] = [];
  const markIfPresent = (prefix: string, object: Record<string, unknown>, fields: string[]) => {
    for (const field of fields) {
      const value = object[field];
      if (value !== undefined && value !== null && value !== '') discarded.push(`${prefix}.${field}`);
    }
  };
  if (raw.uid !== undefined && raw.uid !== null && raw.uid !== '') discarded.push('uid');
  markIfPresent('request', request, ['ip', 'xff', 'ip_prefix', 'ua', 'ua_normalized', 'referer', 'accept_language', 'language_normalized']);
  markIfPresent('device_guess', deviceGuess, ['key', 'network_key', 'source', 'confidence', 'has_uid', 'ip_prefix', 'ua', 'language', 'hint']);
  markIfPresent('cookies', cookies, ['has_uid', 'has_page', 'has_pw']);

  const unsigned = {
    schema: 'glaciereq.engagement-observation.v1' as const,
    source: 'uportal' as const,
    observedAt,
    event,
    publicationId,
    token: stringValue(raw.token),
    publicationType: stringValue(meta.type),
    shortId: stringValue(meta.short_id),
    subject: stringValue(meta.subj),
    recipients: stringArray(meta.mails),
    actor: stringValue(meta.actor),
    owner: stringValue(meta.owner),
    createdBy: stringValue(meta.created_by),
    publishedAt: validIso(meta.published_at),
    sourceFile: {
      sequence: typeof file.seq === 'number' && Number.isFinite(file.seq) ? file.seq : undefined,
      name: stringValue(file.name),
    },
    counter: {
      decremented: typeof counter.decremented === 'boolean' ? counter.decremented : undefined,
      remainingBefore: stringValue(counter.remaining_before),
      remainingAfter: stringValue(counter.remaining_after),
    },
    privacy: {
      retainedFields: [
        'ts', 'event', 'publication', 'token', 'file.seq', 'file.name', 'meta.type', 'meta.short_id',
        'meta.subj', 'meta.mails', 'meta.actor', 'meta.owner', 'meta.created_by', 'meta.published_at',
        'counter.decremented', 'counter.remaining_before', 'counter.remaining_after',
      ],
      discardedSensitiveFields: [...new Set(discarded)].sort(),
      policy: 'EVIDENCE_MINIMAL' as const,
    },
    sourcePayloadSha256: sha256Canonical(raw),
  };

  return { ...unsigned, evidenceSha256: sha256Canonical(unsigned) };
}

function firstOutboundAt(snapshot: EmailOperationalSnapshot): string | undefined {
  return snapshot.timeline.find(event => event.direction === 'OUTBOUND')?.at;
}

function firstInboundAfter(snapshot: EmailOperationalSnapshot, triggerAt: string): string | undefined {
  const triggerMs = Date.parse(triggerAt);
  return snapshot.timeline.find(event => event.direction === 'INBOUND' && Date.parse(event.at) >= triggerMs)?.at;
}

function firstAcknowledgementAt(snapshot: EmailOperationalSnapshot, triggerAt?: string): string | undefined {
  const ids = new Set(snapshot.acknowledgementSignals);
  const triggerMs = triggerAt ? Date.parse(triggerAt) : Number.NEGATIVE_INFINITY;
  return snapshot.timeline.find(event => ids.has(event.messageId) && Date.parse(event.at) >= triggerMs)?.at;
}

function firstEvidenceAttachmentAt(snapshot: EmailOperationalSnapshot, triggerAt: string): string | undefined {
  const triggerMs = Date.parse(triggerAt);
  return snapshot.timeline.find(event => event.direction === 'INBOUND' && event.attachments.length > 0 && Date.parse(event.at) >= triggerMs)?.at;
}

function addDeadline(triggerAt: string, unit: DeadlineUnit, value: number, holidays: string[] = []): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Deadline value must be a non-negative number');
  const start = new Date(triggerAt);
  if (unit === 'HOURS') return new Date(start.getTime() + value * 3600_000).toISOString();
  if (unit === 'CALENDAR_DAYS') return new Date(start.getTime() + value * 86_400_000).toISOString();

  const holidaySet = new Set(holidays);
  const cursor = new Date(start.getTime());
  let remaining = Math.floor(value);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    const isoDate = cursor.toISOString().slice(0, 10);
    if (day === 0 || day === 6 || holidaySet.has(isoDate)) continue;
    remaining -= 1;
  }
  return cursor.toISOString();
}

export function assessDuty(
  snapshot: EmailOperationalSnapshot,
  observations: EngagementObservation[],
  spec: DutySpec,
  nowMs = Date.now(),
): DutyAssessment {
  let triggerAt: string | undefined;
  const basis: string[] = [];

  if (spec.trigger === 'SENT') {
    triggerAt = firstOutboundAt(snapshot);
    if (triggerAt) basis.push(`Gmail outbound event at ${triggerAt}`);
  } else if (spec.trigger === 'ACKNOWLEDGED') {
    triggerAt = firstAcknowledgementAt(snapshot);
    if (triggerAt) basis.push(`Recipient acknowledgement at ${triggerAt}`);
  } else if (spec.trigger === 'ENGAGEMENT') {
    triggerAt = observations.map(o => o.observedAt).sort()[0];
    if (triggerAt) basis.push(`UPORTAL engagement observation at ${triggerAt}`);
  } else {
    triggerAt = validIso(spec.explicitTriggerAt);
    if (triggerAt) basis.push(`Explicit trigger supplied at ${triggerAt}`);
  }

  if (!triggerAt) {
    return {
      schema: 'glaciereq.notice-duty-assessment.v1',
      dutyId: spec.id,
      authority: spec.authority,
      requiredAction: spec.requiredAction,
      trigger: spec.trigger,
      satisfactionRule: spec.satisfaction,
      status: 'NOT_TRIGGERED',
      evidenceBasis: basis,
      assessmentCaution: 'This engine evaluates a supplied duty specification; it does not independently establish that the cited authority legally applies.',
    };
  }

  const dueAt = addDeadline(triggerAt, spec.deadline.unit, spec.deadline.value, spec.deadline.holidays || []);
  let satisfiedAt: string | undefined;

  if (spec.satisfaction === 'ANY_INBOUND') satisfiedAt = firstInboundAfter(snapshot, triggerAt);
  else if (spec.satisfaction === 'ACKNOWLEDGEMENT') satisfiedAt = firstAcknowledgementAt(snapshot, triggerAt);
  else if (spec.satisfaction === 'SUBSTANTIVE_RESPONSE') satisfiedAt = snapshot.stages.SUBSTANTIVE_RESPONSE ? snapshot.lastInboundAt : undefined;
  else if (spec.satisfaction === 'RECORDS_EVIDENCE_RECEIVED') satisfiedAt = firstEvidenceAttachmentAt(snapshot, triggerAt);
  else satisfiedAt = validIso(spec.explicitSatisfiedAt);

  if (satisfiedAt) basis.push(`Satisfaction evidence observed at ${satisfiedAt}`);
  const status: DutyAssessment['status'] = satisfiedAt ? 'SATISFIED' : nowMs > Date.parse(dueAt) ? 'OVERDUE' : 'PENDING';

  return {
    schema: 'glaciereq.notice-duty-assessment.v1',
    dutyId: spec.id,
    authority: spec.authority,
    requiredAction: spec.requiredAction,
    trigger: spec.trigger,
    satisfactionRule: spec.satisfaction,
    status,
    triggerAt,
    dueAt,
    satisfiedAt,
    evidenceBasis: basis,
    assessmentCaution: 'This engine evaluates a supplied duty specification; it does not independently establish that the cited authority legally applies.',
  };
}

function buildAssertions(snapshot: EmailOperationalSnapshot, observations: EngagementObservation[]): EvidenceAssertion[] {
  const outbound = snapshot.timeline.filter(event => event.direction === 'OUTBOUND');
  const inbound = snapshot.timeline.filter(event => event.direction === 'INBOUND');
  const hasAck = Boolean(snapshot.stages.ACKNOWLEDGED);
  const hasEngagement = observations.length > 0;
  const bounced = snapshot.deliveryState === 'BOUNCED_OR_REJECTED';

  const assertions: EvidenceAssertion[] = [
    {
      proposition: 'An outbound message was transmitted from the connected Gmail account.',
      truthState: outbound.length ? 'ESTABLISHED' : 'NOT_ESTABLISHED',
      basis: outbound.map(event => `gmail:${event.messageId}:${event.at}`),
    },
    {
      proposition: 'A provider-side delivery exception was observed.',
      truthState: bounced ? 'ESTABLISHED' : 'NOT_OBSERVED',
      basis: bounced ? snapshot.timeline.filter(event => /delivery|undeliverable|rejected|unknown/i.test(`${event.subject} ${event.snippet}`)).map(event => `gmail:${event.messageId}:${event.at}`) : [],
      caution: bounced ? undefined : 'Absence of a bounce or rejection is not affirmative proof of final delivery.',
    },
    {
      proposition: 'Recipient-side engagement with a controlled UPORTAL publication was observed.',
      truthState: hasEngagement ? 'OBSERVED' : 'NOT_OBSERVED',
      basis: observations.map(observation => `uportal:${observation.event}:${observation.observedAt}:${observation.evidenceSha256}`),
      caution: hasEngagement ? 'Automated security scanners, proxies, caching, forwarding, or shared systems can generate engagement events; this does not by itself prove which human acted.' : undefined,
    },
    {
      proposition: 'The correspondence contains a recipient acknowledgement or reply evidencing receipt/knowledge.',
      truthState: hasAck ? 'ESTABLISHED' : inbound.length ? 'SUPPORTED' : 'NOT_ESTABLISHED',
      basis: hasAck ? snapshot.acknowledgementSignals.map(id => `gmail:${id}`) : inbound.map(event => `gmail:${event.messageId}:${event.at}`),
    },
    {
      proposition: 'A particular human personally read and understood the entire message.',
      truthState: hasAck || Boolean(snapshot.stages.SUBSTANTIVE_RESPONSE) ? 'SUPPORTED' : 'NOT_ESTABLISHED',
      basis: hasAck ? snapshot.acknowledgementSignals.map(id => `gmail:${id}`) : [],
      caution: 'Open/access telemetry alone never establishes human reading or comprehension.',
    },
    {
      proposition: 'The email constituted legally sufficient service of process or other formal service.',
      truthState: 'NOT_ESTABLISHED',
      basis: [],
      caution: 'Formal service must be established separately from ordinary transmission, delivery, access, or notice evidence under the governing rule or consent framework.',
    },
  ];
  return assertions;
}

export function buildNoticeEvidenceRecord(
  snapshot: EmailOperationalSnapshot,
  observations: EngagementObservation[] = [],
  dutySpec?: DutySpec,
  nowMs = Date.now(),
): NoticeEvidenceRecord {
  const orderedObservations = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const unsigned = {
    schema: 'glaciereq.notice-evidence.v1' as const,
    generatedAt: new Date(nowMs).toISOString(),
    threadId: snapshot.threadId,
    normalizedSubject: snapshot.normalizedSubject,
    participants: snapshot.participants,
    gmailEvidenceDigestSha256: snapshot.evidenceDigestSha256,
    gmailSnapshot: snapshot,
    engagementObservations: orderedObservations,
    assertions: buildAssertions(snapshot, orderedObservations),
    dutyAssessment: dutySpec ? assessDuty(snapshot, orderedObservations, dutySpec, nowMs) : undefined,
  };
  return { ...unsigned, recordDigestSha256: sha256Canonical(unsigned) };
}
