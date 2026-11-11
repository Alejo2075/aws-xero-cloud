export interface SqsMessageAttribute {
  dataType: string;
  stringValue?: string | undefined;
  /** base64 */
  binaryValue?: string | undefined;
}

export interface SqsMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  md5OfBody: string | undefined;
  attributes: Record<string, string>;
  messageAttributes: Record<string, SqsMessageAttribute>;
}

export interface QueueInfo {
  visibilityTimeoutSec: number;
  hasDeadLetterQueue: boolean;
  fifo: boolean;
}

export interface BatchEntry {
  id: string;
  receiptHandle: string;
}

/** Thin port over the SQS API so the delivery logic is testable without AWS. */
export interface SqsPort {
  getQueueInfo(): Promise<QueueInfo>;
  receive(options: { maxMessages: number; waitSeconds: number; signal: AbortSignal }): Promise<SqsMessage[]>;
  /** Returns the entry ids that failed to delete. */
  deleteBatch(entries: readonly BatchEntry[]): Promise<{ failed: string[] }>;
  changeVisibility(entries: readonly BatchEntry[], timeoutSec: number): Promise<{ failed: string[] }>;
}

/** Lambda-compatible `SQSEvent` (the shape handlers already know). */
export interface SqsEventRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<
    string,
    { stringValue?: string | undefined; binaryValue?: string | undefined; stringListValues: string[]; binaryListValues: string[]; dataType: string }
  >;
  md5OfBody: string | undefined;
  eventSource: 'aws:sqs';
  eventSourceARN: string;
  awsRegion: string;
}
export interface SqsEvent {
  Records: SqsEventRecord[];
}

export interface DeliveryOutcome {
  status: 'succeeded' | 'function-error' | 'accepted';
  payload: Uint8Array;
}
export type DeliverFn = (event: SqsEvent) => Promise<DeliveryOutcome>;
