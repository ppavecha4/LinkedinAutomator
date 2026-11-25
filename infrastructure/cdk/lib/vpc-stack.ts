/**
 * VPC stack — the network backbone for every other stack.
 *
 * Layout:
 *   3 AZs × 3 subnet tiers:
 *     PUBLIC             — ALB + NAT gateways
 *     PRIVATE_WITH_EGRESS — ECS Fargate tasks (egress via NAT)
 *     PRIVATE_ISOLATED    — Aurora + ElastiCache + interface endpoints
 *
 * NAT gateways: one per AZ (natGateways: 3) for high availability.
 * VPC Flow Logs: streamed to a dedicated CloudWatch log group.
 */

import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  FlowLogTrafficType,
  IpAddresses,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class VpcStack extends Stack {
  public readonly vpc: Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 3,
      natGateways: 3, // HA — one NAT per AZ
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22,
        },
        {
          name: 'isolated',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // VPC flow logs → CloudWatch. 90-day retention; adjust per compliance need.
    const flowLogGroup = new LogGroup(this, 'VpcFlowLogs', {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new FlowLog(this, 'VpcFlowLog', {
      resourceType: FlowLogResourceType.fromVpc(this.vpc),
      destination: FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: FlowLogTrafficType.ALL,
    });
  }
}
