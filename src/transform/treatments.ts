import crypto from 'node:crypto';
import type { CareLinkData, CareLinkMarker, CareLinkNotification } from '../types/carelink.js';
import type { NightscoutTreatment } from '../types/nightscout.js';
import * as logger from '../logger.js';

export interface TreatmentTransformOptions {
  enableTreatments: boolean;
  enableAutoBasalTreatments: boolean;
  enableNotifications: boolean;
  treatmentsLimit: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const wrappedKeys = ['items', 'history', 'notifications', 'markers', 'data', 'value'];
  for (const key of wrappedKeys) {
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
  }

  return [record as T];
}

function extractStringFromKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
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

function markerCategory(kind: string): 'MEAL' | 'INSULIN' | 'AUTO_BASAL_DELIVERY' | 'AUTO_CORRECTION_BOLUS' | 'UNKNOWN' {
  if (kind === 'MEAL' || kind.includes('MEAL') || kind.includes('CARB')) return 'MEAL';
  if (kind.includes('AUTO') && kind.includes('CORRECTION')) return 'AUTO_CORRECTION_BOLUS';
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

function markerFlag(marker: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = marker[key];
    if (value === true) return true;
    if (typeof value === 'string' && ['true', 'yes', '1'].includes(value.toLowerCase())) return true;
    if (typeof value === 'number' && value === 1) return true;
  }
  return false;
}

function markerContext(marker: Record<string, unknown>): string {
  const parts: string[] = [];

  const source = extractStringFromKeys(marker, ['source', 'origin', 'entryType', 'deliveryType']);
  if (source) parts.push(`source=${source}`);

  if (markerFlag(marker, ['autoCorrectionBolus', 'automaticCorrection', 'isAutoCorrection', 'autoCorrection'])) {
    parts.push('autoCorrection=true');
  }

  if (markerFlag(marker, ['mealBolus', 'foodBolus', 'enteredFood', 'carbBolus'])) {
    parts.push('mealBolus=true');
  }

  const carbs = extractNumberFromKeys(marker, ['carbs', 'carbInput', 'mealCarbs']);
  if (carbs !== undefined) parts.push(`carbs=${carbs}`);

  const insulin = extractNumberFromKeys(marker, ['amount', 'insulin', 'value', 'deliveredFastAmount', 'deliveredAmount']);
  if (insulin !== undefined) parts.push(`insulin=${insulin}`);

  return parts.join(' ');
}

function markerDiagnostics(markers: CareLinkMarker[]): {
  total: number;
  byKind: Array<[string, number]>;
  byCategory: Record<string, number>;
  basalSignalMarkers: number;
} {
  const byKind = new Map<string, number>();
  const byCategory: Record<string, number> = {
    MEAL: 0,
    INSULIN: 0,
    AUTO_BASAL_DELIVERY: 0,
    AUTO_CORRECTION_BOLUS: 0,
    UNKNOWN: 0,
  };

  let basalSignalMarkers = 0;

  for (const marker of markers) {
    const kind = markerKind(marker) || 'UNKNOWN_KIND';
    byKind.set(kind, (byKind.get(kind) || 0) + 1);

    const category = markerCategory(kind);
    byCategory[category] = (byCategory[category] || 0) + 1;

    const record = marker as Record<string, unknown>;
    const basalSignal = extractNumberFromKeys(record, ['basalRate', 'rate', 'deliveredRate'])
      ?? extractNumberFromPaths(record, ['data.basalRate', 'data.rate', 'payload.basalRate', 'payload.rate']);
    if (basalSignal != null && basalSignal > 0) {
      basalSignalMarkers++;
    }
  }

  return {
    total: markers.length,
    byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    byCategory,
    basalSignalMarkers,
  };
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
      notes: `[carelink:${kind}] meal carbs=${carbs}${markerContext(numericMarker) ? ` ${markerContext(numericMarker)}` : ''}`,
    };
  }

  if (category === 'AUTO_CORRECTION_BOLUS') {
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
      eventType: 'Correction Bolus',
      insulin,
      notes: `[carelink:${kind}] auto correction bolus insulin=${insulin}${markerContext(numericMarker) ? ` ${markerContext(numericMarker)}` : ''}`,
    };
  }

  if (category === 'INSULIN') {
    const autoCorrection = markerFlag(numericMarker, [
      'autoCorrectionBolus',
      'automaticCorrection',
      'isAutoCorrection',
      'autoCorrection',
    ]) || (kind.includes('AUTO') && kind.includes('CORRECTION'));
    const mealBolus = markerFlag(numericMarker, [
      'mealBolus',
      'foodBolus',
      'enteredFood',
      'carbBolus',
    ]);

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

    const context = markerContext(numericMarker);
    const mealLabel = mealBolus ? ' meal bolus' : '';

    if (autoCorrection) {
      return {
        ...base,
        eventType: 'Correction Bolus',
        insulin,
        notes: `[carelink:${kind}] auto correction bolus insulin=${insulin}${mealLabel}${context ? ` ${context}` : ''}`,
      };
    }

    return {
      ...base,
      eventType: 'Bolus',
      insulin,
      notes: `[carelink:${kind}] bolus insulin=${insulin}${mealLabel}${context ? ` ${context}` : ''}`,
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
      notes: `[carelink:${kind}] autobasal absolute=${absolute}${markerContext(numericMarker) ? ` ${markerContext(numericMarker)}` : ''}`,
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

function smartGuardAutoBasalFallbackTreatment(
  data: CareLinkData,
  offsetMilliseconds: number,
  options: TreatmentTransformOptions,
): NightscoutTreatment | null {
  if (!options.enableAutoBasalTreatments) {
    return null;
  }

  const algorithm = asRecord(data.therapyAlgorithmState);
  if (!algorithm) {
    return null;
  }

  const rate = extractNumberFromKeys(algorithm, [
    'autoBasalRate',
    'currentAutoBasalRate',
    'activeBasalRate',
    'microBolusEquivalentRate',
    'safeBasalRate',
  ]) ?? extractNumberFromPaths(algorithm, [
    'autoBasal.rate',
    'autoBasal.currentRate',
    'safeBasal.rate',
  ]);

  if (!rate || rate <= 0) {
    return null;
  }

  const smartGuardState = extractStringFromKeys(algorithm, [
    'smartGuardState',
    'autoModeState',
    'state',
    'status',
  ]);

  const duration = extractNumberFromKeys(algorithm, [
    'effectiveDuration',
    'durationMinutes',
  ]) ?? extractNumberFromPaths(algorithm, [
    'autoBasal.durationMinutes',
    'safeBasal.durationMinutes',
  ]);

  const timestampText = data.sMedicalDeviceTime;
  const createdAt = Number.isFinite(Date.parse(timestampText))
    ? asIsoString(parsePumpTime(timestampText, offsetMilliseconds))
    : asIsoString(data.lastMedicalDeviceDataUpdateServerTime);

  const stateLabel = smartGuardState ? ` state=${smartGuardState}` : '';

  return {
    eventType: 'Temp Basal',
    created_at: createdAt,
    enteredBy: 'carelink-bridge',
    absolute: rate,
    duration: duration && duration > 0 ? duration : undefined,
    notes: `[carelink:AUTO_BASAL_STATE] smartguard autobasal absolute=${rate}${stateLabel}`,
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

  const markers = toArray<CareLinkMarker>(data.markers);
  const notificationHistory = toArray<CareLinkNotification>(data.notificationHistory);
  const diagnostics = markerDiagnostics(markers);

  const markerTreatments = markers
    .map((marker) => markerToTreatment(marker, device, offsetMilliseconds, options))
    .filter((value): value is NightscoutTreatment => value !== null);

  const autoBasalTreatments = markerTreatments.filter(
    treatment => treatment.eventType === 'Temp Basal',
  );

  const fallbackAutoBasal = autoBasalTreatments.length === 0
    ? smartGuardAutoBasalFallbackTreatment(data, offsetMilliseconds, options)
    : null;

  const notificationTreatments = options.enableNotifications
    ? notificationHistory
        .map((notification) => notificationToTreatment(notification, offsetMilliseconds))
        .filter((value): value is NightscoutTreatment => value !== null)
    : [];

  logger.log(
    '[Treatments] markers=',
    markers.length,
    'notifications=',
    notificationHistory.length,
    'mappedMarkerTreatments=',
    markerTreatments.length,
    'mappedNotificationTreatments=',
    notificationTreatments.length,
    'fallbackAutoBasal=',
    fallbackAutoBasal ? 'yes' : 'no',
  );

  logger.log(
    '[Treatments] markerCategories=',
    JSON.stringify(diagnostics.byCategory),
    'basalSignalMarkers=',
    diagnostics.basalSignalMarkers,
  );

  logger.log(
    '[Treatments] markerKindsTop=',
    JSON.stringify(diagnostics.byKind.slice(0, 12)),
  );

  if (data.therapyAlgorithmState) {
    logger.log('[SmartGuard] therapyAlgorithmState=', JSON.stringify(data.therapyAlgorithmState));
  }

  return withDeterministicIds([
    ...markerTreatments,
    ...(fallbackAutoBasal ? [fallbackAutoBasal] : []),
    ...notificationTreatments,
  ])
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-Math.max(0, options.treatmentsLimit));
}