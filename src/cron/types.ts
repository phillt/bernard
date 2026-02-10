export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastRunStatus?: 'success' | 'error' | 'running';
  lastResult?: string;
}

export interface CronAlert {
  id: string;
  jobId: string;
  jobName: string;
  message: string;
  timestamp: string;
  prompt: string;
  response: string;
  acknowledged: boolean;
}
