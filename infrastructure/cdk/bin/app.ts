#!/usr/bin/env node
/**
 * AI Sales Agent — CDK v2 app entrypoint.
 *
 * Stack topology (all in one environment per synth):
 *
 *   vpc          ─┬─▶ data
 *                 ├─▶ messaging
 *                 └─▶ compute  (consumes data + messaging + ai)
 *                              │
 *   ai ──────────────────┐     │
 *                        ▼     ▼
 *                       compute
 *                        │
 *                        ▼
 *                     monitoring  (references all of the above)
 *
 * Context parameters (set with `cdk synth -c <key>=<value>` or in cdk.json):
 *   stage              — production (default) | staging | dev
 *   certificateArn     — ACM cert for ALB HTTPS listener (optional; without
 *                        it the API listener falls back to HTTP on :80)
 *   imageTag           — ECR image tag to deploy (default "latest")
 *   alertEmail         — email subscribed to the monitoring SNS topic
 */

import 'source-map-support/register';

import { App, Tags } from 'aws-cdk-lib';

import { AiStack } from '../lib/ai-stack';
import { ComputeStack } from '../lib/compute-stack';
import { DataStack } from '../lib/data-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { VpcStack } from '../lib/vpc-stack';

const app = new App();

const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'production';
const certificateArn = app.node.tryGetContext('certificateArn') as string | undefined;
const imageTag =
  (app.node.tryGetContext('imageTag') as string | undefined) ?? 'latest';
const alertEmail = app.node.tryGetContext('alertEmail') as string | undefined;

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region:
    process.env.CDK_DEFAULT_REGION ??
    process.env.AWS_REGION ??
    'ap-south-1',
};

const qualifier = stage === 'production' ? '' : `-${stage}`;

const vpc = new VpcStack(app, `SalesAgent-Vpc${qualifier}`, {
  env,
  description: 'AI Sales Agent — VPC, subnets, NAT, flow logs',
});

const data = new DataStack(app, `SalesAgent-Data${qualifier}`, {
  env,
  vpc: vpc.vpc,
  stage,
  description: 'AI Sales Agent — Aurora PostgreSQL, Redis, S3 buckets',
});
data.addDependency(vpc);

const messaging = new MessagingStack(app, `SalesAgent-Messaging${qualifier}`, {
  env,
  description: 'AI Sales Agent — SQS queues + DLQs, EventBridge schedules',
});

const ai = new AiStack(app, `SalesAgent-Ai${qualifier}`, {
  env,
  description: 'AI Sales Agent — Secrets, Cognito, Bedrock IAM, KMS',
});

const compute = new ComputeStack(app, `SalesAgent-Compute${qualifier}`, {
  env,
  vpc: vpc.vpc,
  database: data.database,
  databaseSecret: data.databaseSecret,
  databaseSecurityGroup: data.dbSecurityGroup,
  redis: data.redisEndpointAddress,
  redisSecurityGroup: data.redisSecurityGroup,
  buckets: data.buckets,
  queues: messaging.queues,
  secrets: ai.secrets,
  cognitoUserPool: ai.userPool,
  bedrockModelId: ai.bedrockModelId,
  imageTag,
  certificateArn,
  stage,
  description: 'AI Sales Agent — ECS Fargate cluster + 4 services',
});
compute.addDependency(vpc);
compute.addDependency(data);
compute.addDependency(messaging);
compute.addDependency(ai);

const monitoring = new MonitoringStack(app, `SalesAgent-Monitoring${qualifier}`, {
  env,
  cluster: compute.cluster,
  services: {
    api: compute.apiService.service,
    orchestrator: compute.orchestratorService,
    outreachWorker: compute.outreachWorkerService,
    replyProcessor: compute.replyProcessorService.service,
  },
  loadBalancers: {
    api: compute.apiService.loadBalancer,
    replyProcessor: compute.replyProcessorService.loadBalancer,
  },
  queues: messaging.queues,
  alertEmail,
  description: 'AI Sales Agent — CloudWatch dashboards and alarms',
});
monitoring.addDependency(compute);
monitoring.addDependency(messaging);

// Project-wide tags — stamped on every resource across every stack.
Tags.of(app).add('Project', 'ai-sales-agent');
Tags.of(app).add('Environment', stage);
Tags.of(app).add('ManagedBy', 'cdk');

app.synth();
