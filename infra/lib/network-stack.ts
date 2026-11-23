import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { StageSettings } from './stage.js';

/**
 * VPC across two AZs: public subnets (NAT only), private subnets (load balancer, API tasks),
 * isolated subnets (database, no route to the internet). Security groups live here so the
 * data and app stacks can reference each other without circular dependencies.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly appSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps & { settings: StageSettings }) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.settings.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      flowLogs: {
        rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', { retention: props.settings.logRetentionDays as logs.RetentionDays }),
          ),
        },
      },
    });

    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Internal API load balancer: only CloudFront VPC origin traffic (rule added in the app stack)',
      allowAllOutbound: false,
    });
    this.appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: 'API tasks and the daily job',
      allowAllOutbound: true, // provider APIs, AWS APIs
    });
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Postgres: only from API tasks',
      allowAllOutbound: false,
    });

    this.albSg.addEgressRule(this.appSg, ec2.Port.tcp(3000), 'ALB to API tasks');
    this.appSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), 'API from ALB only');
    this.dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), 'Postgres from API tasks only');
  }
}
