import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { StageSettings } from './stage.js';

export interface AppStackProps extends StackProps {
  readonly settings: StageSettings;
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.SecurityGroup;
  readonly appSg: ec2.ISecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly dbName: string;
  readonly appSecrets: Record<'jwt' | 'otpPepper' | 'fieldKey' | 'webhook', secrets.ISecret>;
  readonly alertEmail?: string;
}

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * API on Fargate behind an internal load balancer (reachable only through CloudFront's
 * VPC origin), plus the daily arrears job as a scheduled one-off task from the same image.
 */
export class AppStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const s = props.settings;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Built by CDK from the repo during deploy (GitHub Actions has registry access).
    const image = ecs.ContainerImage.fromAsset(REPO_ROOT, { file: 'apps/api/Dockerfile' });

    const environment: Record<string, string> = {
      APP_ENV: s.appEnv,
      PORT: '3000',
      DB_HOST: props.db.instanceEndpoint.hostname,
      DB_PORT: props.db.instanceEndpoint.port.toString(),
      DB_NAME: props.dbName,
      DB_SSL_CA_FILE: '/etc/rds/global-bundle.pem',
      MESSAGING_PROVIDER: 'sandbox',
      COLLECTIONS_PROVIDER: 'sandbox',
    };
    const dbSecret = props.db.secret!;
    const secretsMap: Record<string, ecs.Secret> = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      AUTH_JWT_SECRET: ecs.Secret.fromSecretsManager(props.appSecrets.jwt),
      AUTH_OTP_PEPPER: ecs.Secret.fromSecretsManager(props.appSecrets.otpPepper),
      AUTH_FIELD_KEY: ecs.Secret.fromSecretsManager(props.appSecrets.fieldKey),
      COLLECTIONS_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(props.appSecrets.webhook),
    };

    // ---------------- API service ----------------
    const apiLogs = new logs.LogGroup(this, 'ApiLogs', { retention: s.logRetentionDays as logs.RetentionDays });
    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: s.taskCpu,
      memoryLimitMiB: s.taskMemoryMiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    apiTask.addContainer('api', {
      image,
      environment: { ...environment, MIGRATE_ON_BOOT: 'true' }, // advisory-locked, safe with several tasks
      secrets: secretsMap,
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: 'api' }),
      portMappings: [{ containerPort: 3000 }],
      readonlyRootFilesystem: true,
      healthCheck: {
        command: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        interval: Duration.seconds(30),
        startPeriod: Duration.seconds(60),
      },
    });

    const service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: s.desiredCount,
      securityGroups: [props.appSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      enableExecuteCommand: false,
    });
    const scaling = service.autoScaleTaskCount({ minCapacity: s.desiredCount, maxCapacity: s.maxCount });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      dropInvalidHeaderFields: true,
    });
    const listener = this.alb.addListener('Http', { port: 80, open: false });
    listener.addTargets('Api', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/v1/health', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(20),
    });

    // Allow the load balancer to receive only CloudFront origin-facing traffic. The managed
    // prefix list id differs per region, so it is looked up at deploy time.
    const prefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing'),
        outputPaths: ['PrefixLists.0.PrefixListId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
    });
    // Declared in this stack (not via addIngressRule) so the network stack does not depend on it.
    new ec2.CfnSecurityGroupIngress(this, 'AlbFromCloudFront', {
      groupId: props.albSg.securityGroupId,
      sourcePrefixListId: prefixList.getResponseField('PrefixLists.0.PrefixListId'),
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      description: 'CloudFront VPC origin only',
    });

    // ---------------- Alerts ----------------
    this.alerts = new sns.Topic(this, 'Alerts', { displayName: 'Platform alerts' });
    if (props.alertEmail) this.alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));

    // ---------------- Daily arrears job ----------------
    const jobLogs = new logs.LogGroup(this, 'JobLogs', { retention: s.logRetentionDays as logs.RetentionDays });
    const jobTask = new ecs.FargateTaskDefinition(this, 'DailyJobTask', { cpu: 256, memoryLimitMiB: 512 });
    jobTask.addContainer('job', {
      image,
      command: ['node', 'dist/cli/daily-job.js'],
      environment,
      secrets: secretsMap,
      logging: ecs.LogDrivers.awsLogs({ logGroup: jobLogs, streamPrefix: 'daily' }),
      readonlyRootFilesystem: true,
    });
    // 23:05 UTC = 00:05 in Lagos (UTC+1, no daylight saving).
    new events.Rule(this, 'DailyJobSchedule', {
      schedule: events.Schedule.cron({ minute: '5', hour: '23' }),
      targets: [
        new targets.EcsTask({
          cluster,
          taskDefinition: jobTask,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [props.appSg],
        }),
      ],
    });
    // Any job container that exits non-zero raises an alert.
    new events.Rule(this, 'DailyJobFailed', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          taskDefinitionArn: [jobTask.taskDefinitionArn],
          lastStatus: ['STOPPED'],
          containers: { exitCode: [{ 'anything-but': 0 }] },
        },
      },
      targets: [new targets.SnsTopic(this.alerts)],
    });

    new CfnOutput(this, 'AlertsTopicArn', { value: this.alerts.topicArn });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}
