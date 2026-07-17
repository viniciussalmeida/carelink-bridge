export interface Config {
  username: string;
  password: string;
  nsHost?: string;
  nsBaseUrl?: string;
  nsSecret: string;
  interval: number;
  sgvLimit: number;
  maxRetryDuration: number;
  verbose: boolean;
  enableTreatments: boolean;
  enableNotifications: boolean;
  enableAutoBasalTreatments: boolean;
  treatmentsLimit: number;
  patientId?: string;
  countryCode: string;
  language: string;
}
