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

function extractNestedNumber(record: Record<string, unknown>, path: string): number | undefined {
  const segments = path.split('.');
  let current: unknown = record;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === 'number' && Number.isFinite(current)) return current;
  if (typeof current === 'string') {
    const parsed = Number.parseFloat(current);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function extractNumberFromPaths(record: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = extractNestedNumber(record, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function markerCategory(kind: string): 'MEAL' | 'INSULIN' | 'AUTO_BASAL_DELIVERY' | 'UNKNOWN' {
  if (kind === 'MEAL' || kind.includes('MEAL') || kind.includes('CARB')) return 'MEAL';
  if (kind === 'INSULIN' || kind.includes('INSULIN') || kind.includes('BOLUS')) return 'INSULIN';
  if (kind === 'AUTO_BASAL_DELIVERY' || (kind.includes('AUTO') && kind.includes('BASAL'))) {
    return 'AUTO_BASAL_DELIVERY';
  }
  return 'UNKNOWN';
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
  const category = markerCategory(kind);
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

  if (category === 'MEAL') {
    const carbs = extractNumberFromKeys(numericMarker, [
      'carbs',
      'amount',
      'value',
      'quantity',
      'carbInput',
      'mealCarbs',
    ]) ?? extractNumberFromPaths(numericMarker, [
      'data.carbs',
      'data.carbInput',
      'data.mealCarbs',
      'data.amount',
      'payload.carbs',
      'payload.amount',
    ]);
    if (!carbs || carbs <= 0) return null;
    return {
      ...base,
      eventType: 'Carb Correction',
      carbs,
      notes: `[carelink:${kind}] carbs=${carbs}`,
    };
  }

  if (category === 'INSULIN') {
    const insulin = extractNumberFromKeys(numericMarker, [
      'amount',
      'insulin',
      'value',
      'deliveredFastAmount',
      'programmedFastAmount',
      'deliveredAmount',
      'insulinAmount',
      'normal',
      'bolusVolumeDelivered',
      'requestedBolusAmount',
      'totalDeliveredBolus',
    ]) ?? extractNumberFromPaths(numericMarker, [
      'data.amount',
      'data.insulin',
      'data.value',
      'data.deliveredFastAmount',
      'data.programmedFastAmount',
      'data.deliveredAmount',
      'data.insulinAmount',
      'payload.amount',
      'payload.insulin',
      'payload.deliveredFastAmount',
      'payload.deliveredAmount',
      'bolus.amount',
      'bolus.deliveredFastAmount',
    ]);
    if (!insulin || insulin <= 0) return null;
    return {
      ...base,
      eventType: 'Bolus',
      insulin,
      notes: `[carelink:${kind}] insulin=${insulin}`,
    };
  }

  if (category === 'AUTO_BASAL_DELIVERY') {
    if (!options.enableAutoBasalTreatments) return null;

    const absolute = extractNumberFromKeys(numericMarker, [
      'basalRate',
      'amount',
      'value',
      'rate',
      'deliveredRate',
    ]) ?? extractNumberFromPaths(numericMarker, [
      'data.basalRate',
      'data.rate',
      'data.amount',
      'payload.basalRate',
      'payload.rate',
    ]);
    const duration = extractNumberFromKeys(numericMarker, [
      'duration',
      'durationMinutes',
      'effectiveDuration',
      'length',
    ]) ?? extractNumberFromPaths(numericMarker, [
      'data.duration',
      'data.durationMinutes',
      'payload.duration',
      'payload.durationMinutes',
    ]);

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