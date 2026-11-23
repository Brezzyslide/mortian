/** Sizing and safety settings per environment. Production is deliberately stricter. */
export interface StageSettings {
  readonly stage: 'staging' | 'prod';
  readonly appEnv: 'staging' | 'production';
  readonly natGateways: number;
  readonly dbInstance: string;
  readonly dbMultiAz: boolean;
  readonly dbBackupDays: number;
  readonly dbDeletionProtection: boolean;
  readonly taskCpu: number;
  readonly taskMemoryMiB: number;
  readonly desiredCount: number;
  readonly maxCount: number;
  readonly logRetentionDays: number;
}

export const STAGES: Record<'staging' | 'prod', StageSettings> = {
  staging: {
    stage: 'staging',
    appEnv: 'staging',
    natGateways: 1,
    dbInstance: 't4g.micro',
    dbMultiAz: false,
    dbBackupDays: 7,
    dbDeletionProtection: false,
    taskCpu: 256,
    taskMemoryMiB: 512,
    desiredCount: 1,
    maxCount: 2,
    logRetentionDays: 30,
  },
  prod: {
    stage: 'prod',
    appEnv: 'production',
    natGateways: 2,
    dbInstance: 't4g.small',
    dbMultiAz: true,
    dbBackupDays: 30,
    dbDeletionProtection: true,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    desiredCount: 2,
    maxCount: 6,
    logRetentionDays: 365,
  },
};
