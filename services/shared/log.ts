export type LogFields = {
  asset_id?: string;
  job_id?: string;
  draft_id?: string;
  publication_id?: string;
  correlation_id?: string;
  [k: string]: unknown;
};

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}
