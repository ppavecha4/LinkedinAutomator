/**
 * Thin SQS publisher. Lazy-constructs the client on first use so the API
 * boots without valid AWS credentials in local dev (where no queue URL is set).
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { env } from '../env';
import { logger } from '../logger';

let client: SQSClient | null = null;

function getClient(): SQSClient {
  if (!client) {
    client = new SQSClient({ region: env.awsRegion });
  }
  return client;
}

/**
 * Publish a JSON payload to an SQS queue.
 *
 * In local dev the queue URL is usually empty — we log the payload and return
 * a fake message id rather than crashing. Production wiring sets real URLs.
 */
export async function publishJson(
  queueUrl: string,
  payload: Record<string, unknown>,
): Promise<{ messageId: string; queued: boolean }> {
  if (!queueUrl) {
    logger.warn('sqs.publishJson: queueUrl empty, skipping', {
      payload_keys: Object.keys(payload),
    });
    return { messageId: 'local-dev-noop', queued: false };
  }
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(payload),
  });
  const result = await getClient().send(command);
  return { messageId: result.MessageId ?? '', queued: true };
}
