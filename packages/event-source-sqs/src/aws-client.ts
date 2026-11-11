import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { XeroError } from '@xero/core';
import type { BatchEntry, QueueInfo, SqsMessage, SqsPort } from './types.js';

export function mapSqsError(e: unknown, operation: string): XeroError {
  if (e instanceof XeroError) return e;
  const err = e as { name?: string; code?: string };
  const name = err.name ?? '';
  if (name === 'AbortError') return new XeroError('AWS_REQUEST_FAILED', `${operation} aborted`);
  if (['AccessDenied', 'AccessDeniedException', 'AWS.SimpleQueueService.AccessDenied'].includes(name)) return new XeroError('AWS_ACCESS_DENIED', `AWS denied ${operation}; check the SQS permissions of the connected identity`, { awsError: name });
  if (['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'].includes(name)) return new XeroError('AWS_TARGET_NOT_FOUND', 'the SQS queue does not exist (Xero never creates queues)', { awsError: name });
  if (['CredentialsProviderError', 'ExpiredToken', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidClientTokenId'].includes(name)) return new XeroError('AWS_CREDENTIALS_ERROR', 'AWS credentials are missing, expired or invalid', { awsError: name });
  if (['RequestThrottled', 'ThrottlingException', 'OverLimit'].includes(name)) return new XeroError('AWS_THROTTLED', `AWS throttled ${operation}`, { awsError: name });
  return new XeroError('AWS_REQUEST_FAILED', `AWS request failed (${operation})`, { awsError: name || err.code || 'unknown' }, { cause: e });
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

export class AwsSqsClient implements SqsPort {
  private readonly client: SQSClient;
  constructor(
    private readonly queueUrl: string,
    region: string,
    credentials: AwsCredentialIdentityProvider,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({ region, credentials });
  }

  async getQueueInfo(): Promise<QueueInfo> {
    try {
      const out = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['VisibilityTimeout', 'RedrivePolicy', 'FifoQueue'] }));
      const a = out.Attributes ?? {};
      return {
        visibilityTimeoutSec: Number(a.VisibilityTimeout ?? 30),
        hasDeadLetterQueue: Boolean(a.RedrivePolicy),
        fifo: a.FifoQueue === 'true' || this.queueUrl.endsWith('.fifo'),
      };
    } catch (e) {
      throw mapSqsError(e, 'sqs:GetQueueAttributes');
    }
  }

  async receive(o: { maxMessages: number; waitSeconds: number; signal: AbortSignal }): Promise<SqsMessage[]> {
    try {
      const out = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: o.maxMessages,
          WaitTimeSeconds: o.waitSeconds,
          MessageSystemAttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: o.signal },
      );
      return (out.Messages ?? []).map((m) => ({
        messageId: m.MessageId ?? '',
        receiptHandle: m.ReceiptHandle ?? '',
        body: m.Body ?? '',
        md5OfBody: m.MD5OfBody,
        attributes: { ...(m.Attributes ?? {}) },
        messageAttributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, { dataType: v.DataType ?? 'String', stringValue: v.StringValue, binaryValue: v.BinaryValue ? b64(v.BinaryValue) : undefined }]),
        ),
      }));
    } catch (e) {
      throw mapSqsError(e, 'sqs:ReceiveMessage');
    }
  }

  async deleteBatch(entries: readonly BatchEntry[]): Promise<{ failed: string[] }> {
    if (entries.length === 0) return { failed: [] };
    try {
      const out = await this.client.send(new DeleteMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: entries.map((e) => ({ Id: e.id, ReceiptHandle: e.receiptHandle })) }));
      return { failed: (out.Failed ?? []).map((f) => f.Id ?? '') };
    } catch (e) {
      throw mapSqsError(e, 'sqs:DeleteMessageBatch');
    }
  }

  async changeVisibility(entries: readonly BatchEntry[], timeoutSec: number): Promise<{ failed: string[] }> {
    if (entries.length === 0) return { failed: [] };
    try {
      const out = await this.client.send(
        new ChangeMessageVisibilityBatchCommand({ QueueUrl: this.queueUrl, Entries: entries.map((e) => ({ Id: e.id, ReceiptHandle: e.receiptHandle, VisibilityTimeout: timeoutSec })) }),
      );
      return { failed: (out.Failed ?? []).map((f) => f.Id ?? '') };
    } catch (e) {
      throw mapSqsError(e, 'sqs:ChangeMessageVisibilityBatch');
    }
  }
}
