// S3 ObjectCreated event as delivered by EventBridge to SQS (POC-003).
export interface ObjectCreatedEvent {
  bucket: string;
  key: string;
}

/** Returns null when the body is not an EventBridge "Object Created" event. */
export function parseObjectCreated(body: string): ObjectCreatedEvent | null {
  let e: any;
  try {
    e = JSON.parse(body);
  } catch {
    return null;
  }
  if (e?.['detail-type'] !== 'Object Created') return null;
  const bucket = e?.detail?.bucket?.name;
  const key = e?.detail?.object?.key;
  return typeof bucket === 'string' && typeof key === 'string' ? { bucket, key } : null;
}
