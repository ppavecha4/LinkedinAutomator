/**
 * Compute stack — ECR repos, ECS Fargate cluster, and the 4 services.
 *
 * Services:
 *   1. api               — ApplicationLoadBalancedFargateService, 2×, HTTPS
 *   2. orchestrator      — FargateService, 1× (SQS-triggered, no LB)
 *   3. outreach-worker   — QueueProcessingFargateService (queue-depth autoscale)
 *   4. reply-processor   — ApplicationLoadBalancedFargateService, 2× (webhooks)
 *
 * Every task:
 *   - Execution role: pull from ECR, write to CloudWatch (CDK default)
 *   - Task role:      specific only (S3, SQS, SES, Bedrock, Secrets)
 *
 * Image tags are read from context (`-c imageTag=<tag>`, default "latest").
 * An ACM cert can be provided via `-c certificateArn=<arn>`; without it, the
 * listeners fall back to HTTP on :80 so `cdk synth` works in dev.
 */

import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  CfnSecurityGroupIngress,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily,
  Protocol,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancedFargateService,
  ApplicationLoadBalancedServiceRecordType,
  QueueProcessingFargateService,
} from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { Secret as SecretsManagerSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import type { AiSecrets } from './ai-stack';
import type { DataBuckets } from './data-stack';
import type { MessagingQueues } from './messaging-stack';

export interface ComputeStackProps extends StackProps {
  readonly vpc: Vpc;
  readonly database: DatabaseCluster;
  readonly databaseSecret: SecretsManagerSecret;
  readonly databaseSecurityGroup: SecurityGroup;
  readonly redis: string;
  readonly redisSecurityGroup: SecurityGroup;
  readonly buckets: DataBuckets;
  readonly queues: MessagingQueues;
  readonly secrets: AiSecrets;
  readonly cognitoUserPool: UserPool;
  readonly bedrockModelId: string;
  readonly imageTag: string;
  readonly certificateArn?: string;
  readonly stage: string;
}

const PLATFORM = {
  cpuArchitecture: CpuArchitecture.X86_64,
  operatingSystemFamily: OperatingSystemFamily.LINUX,
};

export class ComputeStack extends Stack {
  public readonly cluster: Cluster;
  public readonly serviceSecurityGroup: SecurityGroup;

  public readonly apiRepository: Repository;
  public readonly orchestratorRepository: Repository;
  public readonly outreachWorkerRepository: Repository;
  public readonly replyProcessorRepository: Repository;

  public readonly apiService: ApplicationLoadBalancedFargateService;
  public readonly orchestratorService: FargateService;
  public readonly outreachWorkerService: FargateService;
  public readonly replyProcessorService: ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // ----- ECR repositories -----
    this.apiRepository = new Repository(this, 'ApiRepo', {
      repositoryName: 'sales-agent-api',
      imageScanOnPush: true,
    });
    this.orchestratorRepository = new Repository(this, 'OrchestratorRepo', {
      repositoryName: 'sales-agent-orchestrator',
      imageScanOnPush: true,
    });
    this.outreachWorkerRepository = new Repository(this, 'OutreachWorkerRepo', {
      repositoryName: 'sales-agent-outreach-worker',
      imageScanOnPush: true,
    });
    this.replyProcessorRepository = new Repository(this, 'ReplyProcessorRepo', {
      repositoryName: 'sales-agent-reply-processor',
      imageScanOnPush: true,
    });

    // ----- Cluster -----
    this.cluster = new Cluster(this, 'Cluster', {
      clusterName: 'sales-agent',
      vpc: props.vpc,
      containerInsights: true,
    });

    // Shared SG for all service tasks.
    this.serviceSecurityGroup = new SecurityGroup(this, 'ServiceSg', {
      vpc: props.vpc,
      description: 'AI Sales Agent — shared SG for Fargate tasks',
      allowAllOutbound: true,
    });

    // Open Aurora + Redis SGs to the service SG. We create the ingress as
    // standalone CfnSecurityGroupIngress resources in THIS stack so the
    // rules live in compute, not in data — preserving compute→data as the
    // only direction in the stack dependency graph.
    new CfnSecurityGroupIngress(this, 'AuroraIngressFromServices', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.serviceSecurityGroup.securityGroupId,
      description: 'ECS tasks → Aurora',
    });
    new CfnSecurityGroupIngress(this, 'RedisIngressFromServices', {
      groupId: props.redisSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 6379,
      toPort: 6379,
      sourceSecurityGroupId: this.serviceSecurityGroup.securityGroupId,
      description: 'ECS tasks → Redis',
    });

    // ----- Shared task role (permissions the spec calls out) -----
    const taskRole = new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'AI Sales Agent — shared task role (S3, SQS, SES, Bedrock, Secrets)',
    });

    // Bedrock — invoke the exact model id the Session 4 spec pinned.
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${props.bedrockModelId}`,
        ],
      }),
    );

    // SES — email sending + suppression admin.
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ses:SendEmail',
          'ses:SendRawEmail',
          'ses:GetSendStatistics',
          'ses:PutSuppressedDestination',
          'ses:DeleteSuppressedDestination',
        ],
        resources: ['*'],
      }),
    );

    // X-Ray write — SDK + sidecar.
    taskRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );

    // S3 access — scoped to the three data buckets.
    for (const bucket of [
      props.buckets.emailTemplates,
      props.buckets.auditLogs,
      props.buckets.reportsExport,
    ]) {
      bucket.grantReadWrite(taskRole);
    }

    // SQS — publish + consume on all three queues.
    for (const q of [
      props.queues.campaignQueue,
      props.queues.outreachQueue,
      props.queues.replyQueue,
    ]) {
      q.grantSendMessages(taskRole);
      q.grantConsumeMessages(taskRole);
    }

    // Secrets — read-only on every named secret.
    for (const secret of [
      props.secrets.anthropicApiKey,
      props.secrets.apolloApiKey,
      props.secrets.twilioAccountSid,
      props.secrets.twilioAuthToken,
      props.secrets.linkedinAccessToken,
      props.secrets.calendlyApiKey,
      props.databaseSecret,
    ]) {
      secret.grantRead(taskRole);
    }

    // Aurora client access (future IAM auth path).
    props.database.grantDataApiAccess(taskRole);

    // ----- Shared env + secret maps for every service -----
    const sharedSecrets: Record<string, EcsSecret> = {
      ANTHROPIC_API_KEY: EcsSecret.fromSecretsManager(props.secrets.anthropicApiKey),
      APOLLO_API_KEY: EcsSecret.fromSecretsManager(props.secrets.apolloApiKey),
      TWILIO_ACCOUNT_SID: EcsSecret.fromSecretsManager(props.secrets.twilioAccountSid),
      TWILIO_AUTH_TOKEN: EcsSecret.fromSecretsManager(props.secrets.twilioAuthToken),
      LINKEDIN_ACCESS_TOKEN: EcsSecret.fromSecretsManager(
        props.secrets.linkedinAccessToken,
      ),
      CALENDLY_API_KEY: EcsSecret.fromSecretsManager(props.secrets.calendlyApiKey),
      DATABASE_PASSWORD: EcsSecret.fromSecretsManager(props.databaseSecret, 'password'),
    };

    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: props.stage,
      STAGE: props.stage,
      AWS_REGION: this.region,
      DATABASE_HOST: props.database.clusterEndpoint.hostname,
      DATABASE_NAME: 'salesagent',
      DATABASE_USER: 'salesagent',
      REDIS_HOST: props.redis,
      SQS_CAMPAIGN_QUEUE_URL: props.queues.campaignQueue.queueUrl,
      SQS_OUTREACH_QUEUE_URL: props.queues.outreachQueue.queueUrl,
      SQS_REPLY_QUEUE_URL: props.queues.replyQueue.queueUrl,
      COGNITO_USER_POOL_ID: props.cognitoUserPool.userPoolId,
      COGNITO_REGION: this.region,
      S3_EMAIL_TEMPLATES_BUCKET: props.buckets.emailTemplates.bucketName,
      S3_AUDIT_LOGS_BUCKET: props.buckets.auditLogs.bucketName,
      S3_REPORTS_BUCKET: props.buckets.reportsExport.bucketName,
    };

    // ----- API service (ALB + HTTPS) -----
    this.apiService = new ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster: this.cluster,
      serviceName: 'sales-agent-api',
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      publicLoadBalancer: true,
      taskSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.serviceSecurityGroup],
      runtimePlatform: PLATFORM,
      taskImageOptions: {
        image: ContainerImage.fromEcrRepository(this.apiRepository, props.imageTag),
        containerPort: 3000,
        environment: sharedEnvironment,
        secrets: sharedSecrets,
        taskRole,
        logDriver: LogDriver.awsLogs({ streamPrefix: 'api' }),
      },
      recordType: ApplicationLoadBalancedServiceRecordType.NONE,
      ...(props.certificateArn
        ? {
            protocol: ApplicationProtocol.HTTPS,
            redirectHTTP: true,
            certificate: Certificate.fromCertificateArn(
              this,
              'ApiCertificate',
              props.certificateArn,
            ),
          }
        : { protocol: ApplicationProtocol.HTTP }),
    });
    this.apiService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
    });

    // ----- Orchestrator service (no LB; SQS-triggered) -----
    const orchestratorTask = new FargateTaskDefinition(this, 'OrchestratorTask', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      runtimePlatform: PLATFORM,
    });
    orchestratorTask.addContainer('orchestrator', {
      image: ContainerImage.fromEcrRepository(
        this.orchestratorRepository,
        props.imageTag,
      ),
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      logging: LogDriver.awsLogs({ streamPrefix: 'orchestrator' }),
      portMappings: [{ containerPort: 9000, protocol: Protocol.TCP }],
    });
    this.orchestratorService = new FargateService(this, 'OrchestratorService', {
      cluster: this.cluster,
      serviceName: 'sales-agent-orchestrator',
      taskDefinition: orchestratorTask,
      desiredCount: 1,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.serviceSecurityGroup],
    });

    // ----- Outreach worker (queue-depth autoscaling) -----
    const outreachWorker = new QueueProcessingFargateService(this, 'OutreachWorker', {
      cluster: this.cluster,
      serviceName: 'sales-agent-outreach-worker',
      cpu: 512,
      memoryLimitMiB: 1024,
      image: ContainerImage.fromEcrRepository(
        this.outreachWorkerRepository,
        props.imageTag,
      ),
      queue: props.queues.outreachQueue,
      minScalingCapacity: 2,
      maxScalingCapacity: 20,
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 10, change: +1 },
        { lower: 100, change: +5 },
      ],
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      taskSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.serviceSecurityGroup],
      runtimePlatform: PLATFORM,
      logDriver: LogDriver.awsLogs({ streamPrefix: 'outreach-worker' }),
    });
    this.outreachWorkerService = outreachWorker.service;

    // `QueueProcessingFargateService` owns its own task role; also grant
    // the shared secrets and SES sends directly.
    for (const secret of [
      props.secrets.anthropicApiKey,
      props.secrets.twilioAccountSid,
      props.secrets.twilioAuthToken,
      props.secrets.linkedinAccessToken,
      props.databaseSecret,
    ]) {
      secret.grantRead(outreachWorker.taskDefinition.taskRole);
    }
    outreachWorker.taskDefinition.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'ses:SendEmail',
          'ses:SendRawEmail',
          'sqs:SendMessage',
          'sqs:SendMessageBatch',
        ],
        resources: ['*'],
      }),
    );

    // ----- Reply processor (ALB — webhooks need a public endpoint) -----
    this.replyProcessorService = new ApplicationLoadBalancedFargateService(
      this,
      'ReplyProcessorService',
      {
        cluster: this.cluster,
        serviceName: 'sales-agent-reply-processor',
        cpu: 512,
        memoryLimitMiB: 1024,
        desiredCount: 2,
        publicLoadBalancer: true,
        taskSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.serviceSecurityGroup],
        runtimePlatform: PLATFORM,
        taskImageOptions: {
          image: ContainerImage.fromEcrRepository(
            this.replyProcessorRepository,
            props.imageTag,
          ),
          containerPort: 3001,
          environment: sharedEnvironment,
          secrets: sharedSecrets,
          taskRole,
          logDriver: LogDriver.awsLogs({ streamPrefix: 'reply-processor' }),
        },
        recordType: ApplicationLoadBalancedServiceRecordType.NONE,
        ...(props.certificateArn
          ? {
              protocol: ApplicationProtocol.HTTPS,
              redirectHTTP: true,
              certificate: Certificate.fromCertificateArn(
                this,
                'ReplyProcessorCertificate',
                props.certificateArn,
              ),
            }
          : { protocol: ApplicationProtocol.HTTP }),
      },
    );
    this.replyProcessorService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
    });

    // Harden service SG: only accept traffic from the ALB SGs.
    const albToService = (lbSg: SecurityGroup): void => {
      this.serviceSecurityGroup.addIngressRule(
        Peer.securityGroupId(lbSg.securityGroupId),
        Port.tcpRange(3000, 3001),
        'ALB → services',
      );
    };
    albToService(
      this.apiService.loadBalancer.connections.securityGroups[0] as SecurityGroup,
    );
    albToService(
      this.replyProcessorService.loadBalancer.connections
        .securityGroups[0] as SecurityGroup,
    );
  }
}
