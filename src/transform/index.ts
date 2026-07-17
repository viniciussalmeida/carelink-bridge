import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';
import type { NightscoutSGVEntry, NightscoutDeviceStatus, TransformResult } from '../types/nightscout.js';
import { CARELINK_TREND_TO_NIGHTSCOUT_TREND } from './trend-map.js';
import { guessPumpOffset, guessPumpOffsetMilliseconds } from './pump-offset.js';
import { markerAndNotificationTreatments, type TreatmentTransformOptions } from './treatments.js';

const STALE_DATA_THRESHOLD_MINUTES = 20;

function parsePumpTime(
  pumpTimeString: string,
  _offset: string,
  offsetMilliseconds: number,
): number {
  return Date.parse(pumpTimeString) - offsetMilliseconds;
}

function timestampAsString(timestamp: number): string {
  if (!timestamp || isNaN(timestamp)) {
    return new Date().toISOString();
  }
  return new Date(timestamp).toISOString();
}

function deviceName(data: CareLinkData): string {
  return 'connect-' + data.medicalDeviceFamily.toLowerCase();
}

function deviceStatusEntry(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutDeviceStatus {
  if (data.medicalDeviceFamily === 'GUARDIAN') {
    return {
      created_at: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
      device: deviceName(data),
      uploader: {
        battery: data.medicalDeviceBatteryLevelPercent,
      },
      connect: {
        sensorState: data.sensorState,
        calibStatus: data.calibStatus,
        sensorDurationHours: data.sensorDurationHours,
        timeToNextCalibHours: data.timeToNextCalibHours,
        conduitInRange: data.conduitInRange,
        conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
        conduitSensorInRange: data.conduitSensorInRange,
        medicalDeviceBatteryLevelPercent: data.medicalDeviceBatteryLevelPercent,
        medicalDeviceFamily: data.medicalDeviceFamily,
      },
    };
  }

  return {
    created_at: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
    device: deviceName(data),
    uploader: {
      battery: data.conduitBatteryLevel,
    },
    pump: {
      battery: { percent: data.medicalDeviceBatteryLevelPercent },
      reservoir: data.reservoirRemainingUnits ?? data.reservoirAmount,
      iob: {
        timestamp: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
        bolusiob: data.activeInsulin?.amount != null && data.activeInsulin.amount >= 0
          ? data.activeInsulin.amount
          : undefined,
      },
      clock: timestampAsString(
        parsePumpTime(data.sMedicalDeviceTime, offset, offsetMilliseconds)
      ),
    },
    connect: {
      sensorState: data.sensorState,
      calibStatus: data.calibStatus,
      sensorDurationHours: data.sensorDurationHours,
      timeToNextCalibHours: data.timeToNextCalibHours,
      conduitInRange: data.conduitInRange,
      conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
      conduitSensorInRange: data.conduitSensorInRange,
    },
  };
}

function sgvEntries(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutSGVEntry[] {
  if (!data.sgs?.length) {
    return [];
  }

  const sgvs: NightscoutSGVEntry[] = data.sgs
    .filter(entry => entry.kind === 'SG' && entry.sg !== 0)
    .map(sgv => {
      const timestamp = parsePumpTime(sgv.datetime, offset, offsetMilliseconds);
      return {
        type: 'sgv' as const,
        sgv: sgv.sg,
        date: timestamp,
        dateString: timestampAsString(timestamp),
        device: deviceName(data),
      };
    });

  // Apply trend data to the most recent SGV
  if (sgvs.length > 0 && data.sgs[data.sgs.length - 1].sg !== 0) {
    const trendData = CARELINK_TREND_TO_NIGHTSCOUT_TREND[data.lastSGTrend];
    if (trendData) {
      sgvs[sgvs.length - 1] = { ...sgvs[sgvs.length - 1], ...trendData };
    }
  }

  return sgvs;
}

export interface TransformOptions extends TreatmentTransformOptions {
  sgvLimit: number;
}

function normalizeOptions(input?: number | Partial<TransformOptions>): TransformOptions {
  if (typeof input === 'number') {
    return {
      sgvLimit: input,
      enableTreatments: true,
      enableAutoBasalTreatments: true,
      enableNotifications: false,
      treatmentsLimit: 72,
    };
  }

  return {
    sgvLimit: input?.sgvLimit ?? Infinity,
    enableTreatments: input?.enableTreatments ?? true,
    enableAutoBasalTreatments: input?.enableAutoBasalTreatments ?? true,
    enableNotifications: input?.enableNotifications ?? false,
    treatmentsLimit: input?.treatmentsLimit ?? 72,
  };
}

export function transform(data: CareLinkData, optionsInput?: number | Partial<TransformOptions>): TransformResult {
  const options = normalizeOptions(optionsInput);
  const recency =
    (data.currentServerTime - data.lastMedicalDeviceDataUpdateServerTime) / (60 * 1000);

  if (recency > STALE_DATA_THRESHOLD_MINUTES) {
    logger.log('Stale CareLink data: ' + recency.toFixed(2) + ' minutes old');
    return { devicestatus: [], entries: [], treatments: [] };
  }

  const offset = guessPumpOffset(data);
  const offsetMilliseconds = guessPumpOffsetMilliseconds(data);
  const treatments = markerAndNotificationTreatments(
    data,
    deviceName(data),
    offsetMilliseconds,
    options,
  );

  return {
    devicestatus: [deviceStatusEntry(data, offset, offsetMilliseconds)],
    entries: sgvEntries(data, offset, offsetMilliseconds).slice(-options.sgvLimit),
    treatments,
  };
}
