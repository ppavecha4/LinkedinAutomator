/**
 * Data stack — Aurora PostgreSQL (Serverless v2), ElastiCache Redis, S3.
 *
 * Outputs:
 *   - `database`          — the Aurora cluster
 *   - `databaseSecret`    — the auto-generated master secret (for compute stack)
 *   - `redisEndpointAddress` — Redis primary endpoint string
 *   - `buckets`           — { emailTemplates, auditLogs, reportsExport }
 *
 * Helpers:
 *   - `allowClientAccessFrom(sg)`  — opens the Aurora SG to a given client SG
 *   - `allowRedisAccessFrom(sg)`   — opens the Redis SG to a given client SG
 */

import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import {
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {
  CfnReplicationGroup,
  CfnSubnetGroup,
} from 'aws-cdk-lib/aws-elasticache';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends StackProps {
  readonly vpc: Vpc;
  readonly stage: string;
}

export interface DataBuckets {
  readonly emailTemplates: s3.Bucket;
  readonly auditLogs: s3.Bucket;
  readonly reportsExport: s3.Bucket;
}

export class DataStack extends Stack {
  public readonly database: DatabaseCluster;
  public readonly databaseSecret: Secret;
  public readonly redisEndpointAddress: string;
  public readonly buckets: DataBuckets;
  public readonly dataKey: Key;

  public readonly dbSecurityGroup: SecurityGroup;
  public readonly redisSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.stage === 'production';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ----- Shared KMS key for at-rest encryption -----
    this.dataKey = new Key(this, 'DataKmsKey', {
      enableKeyRotation: true,
      description: 'AI Sales Agent — at-rest encryption (S3, Aurora, Redis)',
      removalPolicy,
    });

    // ----- Aurora PostgreSQL Serverless v2 -----
    this.dbSecurityGroup = new SecurityGroup(this, 'AuroraSg', {
      vpc: props.vpc,
      description: 'Aurora cluster — private access only',
      allowAllOutbound: false,
    });

    this.databaseSecret = new Secret(this, 'DatabaseMasterSecret', {
      description: 'AI Sales Agent — Aurora master credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'salesagent' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.database = new DatabaseCluster(this, 'Aurora', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_15_4,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 16,
      writer: ClusterInstance.serverlessV2('writer'),
      readers: [
        ClusterInstance.serverlessV2('reader', { scaleWithWriter: true }),
      ],
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      deletionProtection: isProd,
      backup: {
        retention: Duration.days(30),
        preferredWindow: '03:00-04:00',
      },
      preferredMaintenanceWindow: 'Sun:04:00-Sun:05:00',
      defaultDatabaseName: 'salesagent',
      removalPolicy,
      credentials: {
        username: 'salesagent',
        password: this.databaseSecret.secretValueFromJson('password'),
      },
    });

    // ----- ElastiCache Redis (Replication Group for HA) -----
    this.redisSecurityGroup = new SecurityGroup(this, 'RedisSg', {
      vpc: props.vpc,
      description: 'ElastiCache Redis — private access only',
      allowAllOutbound: false,
    });

    const redisSubnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'AI Sales Agent — Redis subnet group',
      subnetIds: props.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED })
        .subnetIds,
    });

    const redis = new CfnReplicationGroup(this, 'RedisCluster', {
      replicationGroupDescription: 'AI Sales Agent — rate limits, suppression cache',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.medium',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      kmsKeyId: this.dataKey.keyArn,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [this.redisSecurityGroup.securityGroupId],
    });
    redis.addDependency(redisSubnetGroup);
    this.redisEndpointAddress = redis.attrPrimaryEndPointAddress;

    // ----- S3 buckets -----
    //
    // NOTE: using AWS-managed S3 encryption (not the customer KMS key). A
    // customer-managed key would require a key policy grant for the compute
    // stack's task role, which creates a data → compute reference and a
    // dependency cycle. If a customer-managed key is required later, move
    // the key to a shared stack (e.g. a SecurityStack) so both data and
    // compute can reference it without introducing a reverse edge.
    const emailTemplates = new s3.Bucket(this, 'EmailTemplatesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy,
      enforceSSL: true,
    });

    const auditLogs = new s3.Bucket(this, 'AuditLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy,
      lifecycleRules: [
        {
          id: 'glacier-after-90-days',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });

    const reportsExport = new s3.Bucket(this, 'ReportsExportBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
    });

    this.buckets = { emailTemplates, auditLogs, reportsExport };
  }
}
