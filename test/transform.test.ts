import { describe, it, expect } from 'vitest';
import { data, makeSG } from './fixtures.js';
import { transform } from '../src/transform/index.js';

describe('transform()', () => {
  it('should return no treatments by default when no markers are present', () => {
    const result = transform(data());
    expect(result.treatments).toEqual([]);
  });

  it('should obey sgvLimit', () => {
    const d = data();
    expect(transform(d).entries).toHaveLength(d.sgs.length);
    expect(transform(d, 4).entries).toHaveLength(4);
  });

  describe('treatments', () => {
    it('should map meal and insulin markers to Nightscout treatments', () => {
      const result = transform(data({
        markers: [
          { type: 'MEAL', datetime: 'Oct 20, 2015 08:00:00', amount: 32 },
          { type: 'INSULIN', datetime: 'Oct 20, 2015 08:05:00', amount: 2.3 },
        ],
      }));

      expect(result.treatments).toHaveLength(2);
      expect(result.treatments[0].eventType).toBe('Carb Correction');
      expect(result.treatments[0].carbs).toBe(32);
      expect(result.treatments[1].eventType).toBe('Bolus');
      expect(result.treatments[1].insulin).toBe(2.3);
      expect(result.treatments[0].id).toBeDefined();
      expect(result.treatments[1].id).toBeDefined();
    });

    it('should map insulin markers with bolus-like kind and deliveredFastAmount', () => {
      const result = transform(data({
        markers: [
          {
            type: 'BOLUS',
            datetime: 'Oct 20, 2015 08:15:00',
            deliveredFastAmount: 1.9,
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Bolus');
      expect(result.treatments[0].insulin).toBe(1.9);
    });

    it('should map insulin markers with nested payload amount', () => {
      const result = transform(data({
        markers: [
          {
            type: 'INSULIN',
            datetime: 'Oct 20, 2015 08:20:00',
            payload: { amount: 2.7 },
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Bolus');
      expect(result.treatments[0].insulin).toBe(2.7);
    });

    it('should label SmartGuard auto correction boluses distinctly', () => {
      const result = transform(data({
        markers: [
          {
            type: 'BOLUS',
            datetime: 'Oct 20, 2015 08:22:00',
            amount: 1.1,
            autoCorrectionBolus: true,
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Correction Bolus');
      expect(result.treatments[0].insulin).toBe(1.1);
      expect(result.treatments[0].notes).toContain('auto correction bolus');
    });

    it('should keep meal boluses annotated as food boluses', () => {
      const result = transform(data({
        markers: [
          {
            type: 'INSULIN',
            datetime: 'Oct 20, 2015 08:24:00',
            amount: 3.4,
            mealBolus: true,
            carbs: 28,
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Bolus');
      expect(result.treatments[0].insulin).toBe(3.4);
      expect(result.treatments[0].notes).toContain('meal bolus');
      expect(result.treatments[0].notes).toContain('carbs=28');
    });

    it('should map AUTO_BASAL_DELIVERY when enabled', () => {
      const result = transform(data({
        markers: [
          {
            type: 'AUTO_BASAL_DELIVERY',
            datetime: 'Oct 20, 2015 08:10:00',
            basalRate: 0.75,
            duration: 5,
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Temp Basal');
      expect(result.treatments[0].absolute).toBe(0.75);
      expect(result.treatments[0].duration).toBe(5);
    });

    it('should map auto basal markers using generic auto basal kind and nested rate', () => {
      const result = transform(data({
        markers: [
          {
            type: 'AUTO_BASAL',
            datetime: 'Oct 20, 2015 08:12:00',
            data: { rate: 0.55, durationMinutes: 10 },
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Temp Basal');
      expect(result.treatments[0].absolute).toBe(0.55);
      expect(result.treatments[0].duration).toBe(10);
    });

    it('should map AUTO_BASAL_DELIVERY bolusAmount to derived hourly Temp Basal', () => {
      const result = transform(data({
        markers: [
          {
            type: 'AUTO_BASAL_DELIVERY',
            datetime: 'Oct 20, 2015 08:14:00',
            bolusAmount: 0.1,
          },
        ],
      }));

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Temp Basal');
      expect(result.treatments[0].absolute).toBeCloseTo(1.2, 6);
      expect(result.treatments[0].duration).toBe(5);
      expect(result.treatments[0].notes).toContain('source=bolusAmount');
    });

    it('should skip AUTO_BASAL_DELIVERY when disabled', () => {
      const result = transform(
        data({
          markers: [
            {
              type: 'AUTO_BASAL_DELIVERY',
              datetime: 'Oct 20, 2015 08:10:00',
              basalRate: 0.75,
              duration: 5,
            },
          ],
        }),
        { enableAutoBasalTreatments: false },
      );

      expect(result.treatments).toHaveLength(0);
    });

    it('should obey treatmentsLimit', () => {
      const result = transform(
        data({
          markers: [
            { type: 'MEAL', datetime: 'Oct 20, 2015 08:00:00', amount: 10 },
            { type: 'MEAL', datetime: 'Oct 20, 2015 08:05:00', amount: 20 },
            { type: 'MEAL', datetime: 'Oct 20, 2015 08:10:00', amount: 30 },
          ],
        }),
        { treatmentsLimit: 2 },
      );

      expect(result.treatments).toHaveLength(2);
      expect(result.treatments[0].carbs).toBe(20);
      expect(result.treatments[1].carbs).toBe(30);
    });

    it('should handle notificationHistory as an object with wrapped notifications', () => {
      const result = transform(
        data({
          notificationHistory: {
            notifications: [
              {
                type: 'ALARM',
                datetime: 'Oct 20, 2015 08:25:00',
                message: 'Low glucose predicted',
              },
            ],
          } as unknown as never[],
        }),
        { enableNotifications: true },
      );

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Announcement');
      expect(result.treatments[0].notes).toContain('ALARM');
    });

    it('should handle markers as an object with wrapped items', () => {
      const result = transform(
        data({
          markers: {
            items: [
              {
                type: 'INSULIN',
                datetime: 'Oct 20, 2015 08:30:00',
                amount: 1.2,
              },
            ],
          } as unknown as never[],
        }),
      );

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Bolus');
      expect(result.treatments[0].insulin).toBe(1.2);
    });

    it('should emit fallback auto basal treatment from therapyAlgorithmState', () => {
      const result = transform(
        data({
          markers: [],
          therapyAlgorithmState: {
            autoBasalRate: 0.65,
            smartGuardState: 'ACTIVE',
            durationMinutes: 5,
          },
        }),
      );

      expect(result.treatments).toHaveLength(1);
      expect(result.treatments[0].eventType).toBe('Temp Basal');
      expect(result.treatments[0].absolute).toBe(0.65);
      expect(result.treatments[0].notes).toContain('AUTO_BASAL_STATE');
    });

    it('should prefer marker-based auto basal over fallback treatment', () => {
      const result = transform(
        data({
          markers: [
            {
              type: 'AUTO_BASAL_DELIVERY',
              datetime: 'Oct 20, 2015 08:40:00',
              basalRate: 0.5,
            },
          ],
          therapyAlgorithmState: {
            autoBasalRate: 0.7,
            smartGuardState: 'ACTIVE',
          },
        }),
      );

      const tempBasals = result.treatments.filter(t => t.eventType === 'Temp Basal');
      expect(tempBasals).toHaveLength(1);
      expect(tempBasals[0].absolute).toBe(0.5);
    });
  });

  describe('smartguard in devicestatus', () => {
    it('should include smartguard fields from therapyAlgorithmState', () => {
      const result = transform(
        data({
          therapyAlgorithmState: {
            smartGuardState: 'ACTIVE',
            autoModeEnabled: true,
            autoBasalRate: 0.72,
          },
        }),
      );

      const connect = result.devicestatus[0].connect;
      expect(connect.smartGuardState).toBe('ACTIVE');
      expect(connect.autoModeEnabled).toBe(true);
      expect(connect.autoBasalRate).toBe(0.72);
      expect(connect.therapyAlgorithmState).toBeDefined();
    });
  });

  it('should include pump device family', () => {
    const result = transform(data({ medicalDeviceFamily: 'foo' }));
    expect(result.entries[0].device).toBe('connect-foo');
  });

  it('should discard data more than 20 minutes old', () => {
    const pumpTimeString = 'Oct 17, 2015 09:06:33';
    const now = Date.parse('Oct 17, 2015 09:09:14');
    const THRESHOLD = 20;
    const boundary = now - THRESHOLD * 60 * 1000;

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary,
      })).entries.length,
    ).toBeGreaterThan(0);

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary - 1,
      })).entries,
    ).toHaveLength(0);
  });

  describe('active insulin', () => {
    it('should include active insulin', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: 1.275,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBe(1.275);
    });

    it('should ignore activeInsulin values of -1', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: -1,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBeUndefined();
    });
  });

  describe('trend', () => {
    const sgs: [number, string][] = [
      [95, 'Oct 20, 2015 08:05:00'],
      [105, 'Oct 20, 2015 08:10:00'],
      [108, 'Oct 20, 2015 08:15:00'],
    ];

    function transformedSGs(valDatePairs: [number, string?][]) {
      return transform(
        data({
          lastSGTrend: 'UP_DOUBLE',
          sgs: valDatePairs.map(([sg, time]) => makeSG(sg, time)),
        }),
      ).entries;
    }

    it('should add the trend to the last sgv', () => {
      const sgvs = transformedSGs(sgs);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBe('DoubleUp');
      expect(sgvs[sgvs.length - 1].trend).toBe(1);
    });

    it('should not add a trend if the most recent sgv is absent', () => {
      const sgvs = transformedSGs([...sgs, [0, 'Oct 20, 2015 08:20:00']]);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBeUndefined();
      expect(sgvs[sgvs.length - 1].trend).toBeUndefined();
    });
  });

  describe('uploader battery', () => {
    it('should use the Connect battery level as uploader.battery', () => {
      const pumpStatus = transform(data({ conduitBatteryLevel: 76 })).devicestatus[0];
      expect(pumpStatus.uploader.battery).toBe(76);
    });
  });
});
