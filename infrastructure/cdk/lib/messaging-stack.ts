/**
 * Messaging stack — SQS queues (+ DLQs) and EventBridge schedules.
 *
 *   campaign-queue   — FIFO, 900s visibility (long-running campaign launches)
 *   outreach-queue   — standard, 300s visibility (channel sends with retries)
 *   reply-queue      — standard, 120s visibility (inbound reply processing)
 *
 * Each queue has its own DLQ with maxReceiveCount=3.
 *
 * EventBridge rules (targets attached in compute-stack):
 *   linkedin-poll-rule      — every 15 minutes
 *   sequence-cadence-rule   — every hour
 */

import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { DeadLetterQueue, Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface MessagingQueues {
  readonly campaignQueue: Queue;
  readonly campaignDlq: Queue;
  readonly outreachQueue: Queue;
  readonly outreachDlq: Queue;
  readonly replyQueue: Queue;
  readonly replyDlq: Queue;
}

export class MessagingStack extends Stack {
  public readonly queues: MessagingQueues;
  public readonly linkedinPollRule: Rule;
  public readonly sequenceCadenceRule: Rule;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const makeDlq = (name: string): Queue =>
      new Queue(this, `${name}Dlq`, {
        encryption: QueueEncryption.KMS_MANAGED,
        retentionPeriod: Duration.days(14),
      });

    const attachDlq = (dlq: Queue): DeadLetterQueue => ({
      queue: dlq,
      maxReceiveCount: 3,
    });

    // Campaign queue — FIFO so launch jobs for a campaign are strictly ordered.
    const campaignDlq = makeDlq('Campaign');
    const campaignQueue = new Queue(this, 'CampaignQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: Duration.seconds(900),
      encryption: QueueEncryption.KMS_MANAGED,
      queueName: 'sales-agent-campaign-queue.fifo',
      deadLetterQueue: attachDlq(campaignDlq),
    });

    const outreachDlq = makeDlq('Outreach');
    const outreachQueue = new Queue(this, 'OutreachQueue', {
      visibilityTimeout: Duration.seconds(300),
      encryption: QueueEncryption.KMS_MANAGED,
      queueName: 'sales-agent-outreach-queue',
      deadLetterQueue: attachDlq(outreachDlq),
    });

    const replyDlq = makeDlq('Reply');
    const replyQueue = new Queue(this, 'ReplyQueue', {
      visibilityTimeout: Duration.seconds(120),
      encryption: QueueEncryption.KMS_MANAGED,
      queueName: 'sales-agent-reply-queue',
      deadLetterQueue: attachDlq(replyDlq),
    });

    this.queues = {
      campaignQueue,
      campaignDlq,
      outreachQueue,
      outreachDlq,
      replyQueue,
      replyDlq,
    };

    // ----- EventBridge schedules -----
    // Targets are attached in compute-stack (using an ECS RunTask or API
    // invocation). Keeping the rules here makes them visible in the messaging
    // stack and avoids cross-stack coupling with the compute stack's VPC.

    this.linkedinPollRule = new Rule(this, 'LinkedInPollRule', {
      ruleName: 'sales-agent-linkedin-poll',
      description: 'Poll LinkedIn for inbound DMs / connection acceptances',
      schedule: Schedule.cron({ minute: '*/15' }),
    });

    this.sequenceCadenceRule = new Rule(this, 'SequenceCadenceRule', {
      ruleName: 'sales-agent-sequence-cadence',
      description: 'Check due sequence steps once per hour',
      schedule: Schedule.cron({ minute: '0' }),
    });
  }
}
