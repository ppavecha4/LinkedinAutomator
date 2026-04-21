/**
 * Monitoring stack — CloudWatch dashboard, alarms, SNS topic.
 *
 * Widgets:
 *   - messages sent / hour            (custom metric, namespace "SalesAgent")
 *   - reply rate                      (custom metric)
 *   - meeting conversion rate         (custom metric)
 *   - queue depths                    (SQS ApproximateNumberOfMessagesVisible)
 *   - error rate per service          (custom metric per Service dimension)
 *   - SES bounce rate                 (AWS/SES Reputation.BounceRate)
 *
 * Alarms (all routed to a single SNS topic → email):
 *   - ses-bounce-rate       > 2%
 *   - outreach-error-rate   > 1%
 *   - reply-queue-depth     > 500
 *   - campaign-queue-depth  > 100
 *   - api-5xx-rate          > 0.5%
 *   - linkedin-rate-limit   > 10 / hour
 *   - suppression-rate      > 5% of sends
 */

import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  MathExpression,
  Metric,
  TextWidget,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Cluster, FargateService } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import type { MessagingQueues } from './messaging-stack';

export interface MonitoringStackProps extends StackProps {
  readonly cluster: Cluster;
  readonly services: {
    readonly api: FargateService;
    readonly orchestrator: FargateService;
    readonly outreachWorker: FargateService;
    readonly replyProcessor: FargateService;
  };
  readonly loadBalancers: {
    readonly api: ApplicationLoadBalancer;
    readonly replyProcessor: ApplicationLoadBalancer;
  };
  readonly queues: MessagingQueues;
  readonly alertEmail?: string;
}

const CUSTOM_NAMESPACE = 'SalesAgent';

export class MonitoringStack extends Stack {
  public readonly alertTopic: Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // ----- SNS alert topic -----
    this.alertTopic = new Topic(this, 'AlertsTopic', {
      displayName: 'AI Sales Agent operational alerts',
    });
    if (props.alertEmail) {
      this.alertTopic.addSubscription(new EmailSubscription(props.alertEmail));
    }

    const snsAction = new SnsAction(this.alertTopic);

    // ----- Metric helpers -----
    const custom = (
      metricName: string,
      stat = 'Sum',
      period = Duration.minutes(5),
    ): Metric =>
      new Metric({
        namespace: CUSTOM_NAMESPACE,
        metricName,
        statistic: stat,
        period,
      });

    const queueDepth = (queueName: string): Metric =>
      new Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        statistic: 'Maximum',
        period: Duration.minutes(1),
        dimensionsMap: { QueueName: queueName },
      });

    const sesBounceRate = new Metric({
      namespace: 'AWS/SES',
      metricName: 'Reputation.BounceRate',
      statistic: 'Maximum',
      period: Duration.minutes(15),
    });

    // ----- Dashboard -----
    const dashboard = new Dashboard(this, 'OperationsDashboard', {
      dashboardName: 'SalesAgent-Operations',
    });

    dashboard.addWidgets(
      new TextWidget({
        width: 24,
        height: 1,
        markdown: '# AI Sales Agent — Operations',
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Messages sent / hour',
        width: 12,
        left: [custom('MessagesSent', 'Sum', Duration.hours(1))],
      }),
      new GraphWidget({
        title: 'Reply rate (%)',
        width: 12,
        left: [custom('ReplyRatePct', 'Average')],
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Meeting conversion rate (%)',
        width: 12,
        left: [custom('MeetingConversionPct', 'Average')],
      }),
      new GraphWidget({
        title: 'SQS queue depths',
        width: 12,
        left: [
          queueDepth(props.queues.campaignQueue.queueName),
          queueDepth(props.queues.outreachQueue.queueName),
          queueDepth(props.queues.replyQueue.queueName),
        ],
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Error rate per service',
        width: 12,
        left: [
          custom('ServiceErrors', 'Sum').with({
            dimensionsMap: { Service: 'api' },
          }),
          custom('ServiceErrors', 'Sum').with({
            dimensionsMap: { Service: 'orchestrator' },
          }),
          custom('ServiceErrors', 'Sum').with({
            dimensionsMap: { Service: 'outreach-worker' },
          }),
          custom('ServiceErrors', 'Sum').with({
            dimensionsMap: { Service: 'reply-processor' },
          }),
        ],
      }),
      new GraphWidget({
        title: 'SES bounce rate',
        width: 12,
        left: [sesBounceRate],
      }),
    );

    // ----- Alarms -----
    const addAlarm = (
      construct: string,
      description: string,
      metric: Metric | MathExpression,
      threshold: number,
      comparison: ComparisonOperator = ComparisonOperator.GREATER_THAN_THRESHOLD,
    ): Alarm => {
      const alarm = new Alarm(this, construct, {
        alarmName: `sales-agent-${construct}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 2,
        comparisonOperator: comparison,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(snsAction);
      return alarm;
    };

    addAlarm(
      'ses-bounce-rate',
      'SES bounce rate above 2% (SES will block us at 5%)',
      sesBounceRate,
      0.02,
    );

    addAlarm(
      'outreach-error-rate',
      'Outreach worker error rate above 1% of attempted sends',
      new MathExpression({
        expression: 'IF(sent > 0, 100 * errors / sent, 0)',
        usingMetrics: {
          errors: custom('ChannelErrors', 'Sum', Duration.minutes(15)),
          sent: custom('MessagesSent', 'Sum', Duration.minutes(15)),
        },
        period: Duration.minutes(15),
      }),
      1,
    );

    addAlarm(
      'reply-queue-depth',
      'Reply queue depth > 500 — reply processor is falling behind',
      queueDepth(props.queues.replyQueue.queueName),
      500,
    );

    addAlarm(
      'campaign-queue-depth',
      'Campaign queue depth > 100 — orchestrator overloaded',
      queueDepth(props.queues.campaignQueue.queueName),
      100,
    );

    // API 5xx rate — ALB HTTPCode_Target_5XX_Count / RequestCount.
    const albLb = props.loadBalancers.api;
    const api5xx = new Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: {
        LoadBalancer: albLb.loadBalancerFullName,
      },
    });
    const apiRequests = new Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: {
        LoadBalancer: albLb.loadBalancerFullName,
      },
    });
    addAlarm(
      'api-5xx-rate',
      'API 5xx rate > 0.5% of requests',
      new MathExpression({
        expression: 'IF(reqs > 0, 100 * errs / reqs, 0)',
        usingMetrics: { errs: api5xx, reqs: apiRequests },
        period: Duration.minutes(5),
      }),
      0.5,
    );

    addAlarm(
      'linkedin-rate-limit-hits',
      'LinkedIn rate-limit hits > 10 in 1 hour — likely to be blocked',
      custom('RateLimitHits', 'Sum', Duration.hours(1)).with({
        dimensionsMap: { Channel: 'linkedin' },
      }),
      10,
    );

    addAlarm(
      'suppression-rate',
      'Suppression-at-dispatch > 5% of attempted sends',
      new MathExpression({
        expression: 'IF(sent > 0, 100 * suppressed / sent, 0)',
        usingMetrics: {
          suppressed: custom('SuppressedAtDispatch', 'Sum', Duration.minutes(15)),
          sent: custom('MessagesSent', 'Sum', Duration.minutes(15)),
        },
        period: Duration.minutes(15),
      }),
      5,
    );
  }
}
