import crypto from 'node:crypto';
import type { CareLinkData, CareLinkMarker, CareLinkNotification } from '../types/carelink.js';
import type { NightscoutTreatment } from '../types/nightscout.js';

export interface TreatmentTransformOptions {
  enableTreatments: boolean;
  enableAutoBasalTreatments: boolean;
  enableNotifications: boolean;
  treatmentsLimit: number;
}

function parsePumpTime(pumpTimeString: string, offsetMilliseconds: number): number {
  return Date.parse(pumpTimeString) - offsetMilliseconds;
}

function asIsoString(timestamp: number): string {
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function extractTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return undefined;
}

function extractNumberFromKeys(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function markerKind(marker: CareLinkMarker): string {
  return String(marker.type || marker.kind || '').toUpperCase();
}

function markerTimestamp(marker: CareLinkMarker): string | undefined {
  return extractTimestamp(marker.datetime)
    || extractTimestamp(marker['dateTime'])
    || extractTimestamp(marker['timestamp']);
}

function markerToTreatment(
  marker: CareLinkMarker,
  device: string,
  offsetMilliseconds: number,
  options: TreatmentTransformOptions,
): NightscoutTreatment | null {
  const kind = markerKind(marker);
  const timestampText = markerTimestamp(marker);
  if (!kind || !timestampText) return null;

  const createdAt = asIsoString(parsePumpTime(timestampText, offsetMilliseconds));
  const base: NightscoutTreatment = {
    eventType: 'Note',
    created_at: createdAt,
    enteredBy: 'carelink-bridge',
    notes: `[carelink:${kind}] device=${device}`,
  };

  const numericMarker = marker as Record<string, unknown>;

  if (kind === 'MEAL') {
    const carbs = extractNumberFromKeys(numericMarker, ['carbs', 'amount', 'value', 'quantity']);
    if (!carbs || carbs <= 0) return null;
    return {
      ...base,
      eventType: 'Carb Correction',
      carbs,
      notes: `[carelink:${kind}] carbs=${carbs}`,
    };
  }

  if (kind === 'INSULIN') {
    const insulin = extractNumberFromKeys(numericMarker, ['amount', 'insulin', 'value']);
    if (!insulin || insulin <= 0) return null;
    return {
      ...base,
      eventType: 'Bolus',
      insulin,
      notes: `[carelink:${kind}] insulin=${insulin}`,
    };
  }

  if (kind === 'AUTO_BASAL_DELIVERY') {
    if (!options.enableAutoBasalTreatments) return null;

    const absolute = extractNumberFromKeys(numericMarker, ['basalRate', 'amount', 'value']);
    const duration = extractNumberFromKeys(numericMarker, ['duration', 'durationMinutes']);

    if (!absolute || absolute <= 0) return null;

    return {
      ...base,
      eventType: 'Temp Basal',
      absolute,
      duration: duration && duration > 0 ? duration : undefined,
      notes: `[carelink:${kind}] absolute=${absolute}`,
    };
  }

  return null;
}

function notificationTimestamp(notification: CareLinkNotification): string | undefined {
  return extractTimestamp(notification.datetime)
    || extractTimestamp(notification['dateTime'])
    || extractTimestamp(notification['timestamp']);
}

function notificationToTreatment(
  notification: CareLinkNotification,
  offsetMilliseconds: number,
): NightscoutTreatment | null {
  const timestampText = notificationTimestamp(notification);
  if (!timestampText) return null;

  const createdAt = asIsoString(parsePumpTime(timestampText, offsetMilliseconds));
  const type = String(notification.type || notification.kind || 'NOTIFICATION').toUpperCase();
  const code = notification.code != null ? ` code=${String(notification.code)}` : '';
  const message = typeof notification.message === 'string' ? ` ${notification.message}` : '';

  return {
    eventType: 'Announcement',
    created_at: createdAt,
    enteredBy: 'carelink-bridge',
    notes: `[carelink:${type}]${code}${message}`.trim(),
  };
}

function withDeterministicIds(treatments: NightscoutTreatment[]): NightscoutTreatment[] {
  return treatments.map((treatment) => {
    const identity = `${treatment.eventType}|${treatment.created_at}|${treatment.insulin ?? ''}|${treatment.carbs ?? ''}|${treatment.duration ?? ''}|${treatment.absolute ?? ''}|${treatment.notes ?? ''}`;
    const id = crypto.createHash('sha1').update(identity).digest('hex');
    return { ...treatment, id };
  });
}

export function markerAndNotificationTreatments(
  data: CareLinkData,
  device: string,
  offsetMilliseconds: number,
  options: TreatmentTransformOptions,
): NightscoutTreatment[] {
  if (!options.enableTreatments) {
    return [];
  }

  const markerTreatments = (data.markers || [])
    .map((marker) => markerToTreatment(marker, device, offsetMilliseconds, options))
    .filter((value): value is NightscoutTreatment => value !== null);

  const notificationTreatments = options.enableNotifications
    ? (data.notificationHistory || [])
        .map((notification) => notificationToTreatment(notification, offsetMilliseconds))
        .filter((value): value is NightscoutTreatment => value !== null)
    : [];

  return withDeterministicIds([...markerTreatments, ...notificationTreatments])
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-Math.max(0, options.treatmentsLimit));
}