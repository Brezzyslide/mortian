import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';
import { CoreStack } from '../lib/core-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { EdgeStack, SPA_REWRITE } from '../lib/edge-stack.js';
import { NetworkStack } from '../lib/network-stack.js';
import { STAGES, type StageSettings } from '../lib/stage.js';
import { WafStack } from '../lib/waf-stack.js';

const env = { account: '111111111111', region: 'af-south-1' };
const consoleDist = mkdtempSync(join(tmpdir(), 'console-'));
writeFileSync(join(consoleDist, 'index.html'), '<!doctype html>');

function build(settings: StageSettings, domain?: { name: string; certificateArn: string }) {
  const app = new App();
  const network = new NetworkStack(app, 'net', { env, settings });
  const core = new CoreStack(app, 'core', { env, stage: settings.stage, slug: 't' });
  const data = new DataStack(app, 'data', { env, settings, vpc: network.vpc, dbSg: network.dbSg, dataKey: core.dataKey });
  const api = new AppStack(app, 'app', {
    env,
    settings,
    vpc: network.vpc,
    albSg: network.albSg,
    appSg: network.appSg,
    db: data.db,
    dbName: data.dbName,
    appSecrets: data.appSecrets,
    contractsBucket: core.contractsBucket,
    dataKey: core.dataKey,
    publicBaseUrl: 'https://api.example.com',
  });
  const waf = new WafStack(app, 'waf', { env: { ...env, region: 'us-east-1' }, crossRegionReferences: true });
  const edge = new EdgeStack(app, 'edge', {
    env,
    crossRegionReferences: true,
    alb: api.alb,
    webAclArn: waf.webAclArn,
    webApps: [
      { prefix: 'app', distPath: consoleDist },
      { prefix: 'console', distPath: consoleDist },
      { prefix: 'sign', distPath: consoleDist },
    ],
    ...(domain ? { domain } : {}),
  });
  return {
    network: Template.fromStack(network),
    data: Template.fromStack(data),
    app: Template.fromStack(api),
    waf: Template.fromStack(waf),
    edge: Template.fromStack(edge),
  };
}

let staging: ReturnType<typeof build>;
let prod: ReturnType<typeof build>;
beforeAll(() => {
  staging = build(STAGES.staging);
  prod = build(STAGES.prod, { name: 'api.example.com', certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/x' });
}, 120_000);

describe('network', () => {
  it('opens Postgres only to the API security group, and nothing to the internet', () => {
    const ingress = Object.values(staging.network.findResources('AWS::EC2::SecurityGroupIngress')) as {
      Properties: { FromPort: number; CidrIp?: string; SourceSecurityGroupId?: unknown };
    }[];
    const groups = Object.values(staging.network.findResources('AWS::EC2::SecurityGroup')) as {
      Properties: { SecurityGroupIngress?: { CidrIp?: string }[] };
    }[];
    const inline = groups.flatMap((g) => g.Properties.SecurityGroupIngress ?? []);
    expect([...ingress.map((r) => r.Properties), ...inline].some((r) => r.CidrIp === '0.0.0.0/0')).toBe(false);
    const pg = ingress.filter((r) => r.Properties.FromPort === 5432);
    expect(pg).toHaveLength(1);
    expect(JSON.stringify(pg[0]!.Properties.SourceSecurityGroupId)).toContain('AppSg');
  });
});

describe('database', () => {
  it('is encrypted, private and forces TLS', () => {
    staging.data.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
      PubliclyAccessible: false,
      Engine: 'postgres',
    });
    staging.data.hasResourceProperties('AWS::RDS::DBParameterGroup', { Parameters: { 'rds.force_ssl': '1' } });
  });

  it('production is multi-AZ, deletion-protected, 30-day backups', () => {
    prod.data.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 30,
    });
  });

  it('every application secret is generated, none is written into the template', () => {
    const s = prod.data.findResources('AWS::SecretsManager::Secret');
    expect(Object.keys(s).length).toBe(5); // 4 app secrets + the RDS credentials
    for (const r of Object.values(s)) {
      const props = (r as { Properties: Record<string, unknown> }).Properties;
      expect(props['GenerateSecretString']).toBeDefined();
      expect(props['SecretString']).toBeUndefined();
    }
  });
});

describe('application', () => {
  it('load balancer is internal and only CloudFront may reach it', () => {
    staging.app.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    staging.app.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 80,
      SourcePrefixListId: Match.anyValue(),
    });
  });

  it('secrets reach containers as secret references, never as plain environment values', () => {
    const defs = staging.app.findResources('AWS::ECS::TaskDefinition');
    for (const d of Object.values(defs)) {
      const c = (d as { Properties: { ContainerDefinitions: { Environment?: { Name: string }[]; Secrets?: { Name: string }[]; ReadonlyRootFilesystem?: boolean }[] } }).Properties
        .ContainerDefinitions[0]!;
      const envNames = (c.Environment ?? []).map((e) => e.Name);
      const secretNames = (c.Secrets ?? []).map((e) => e.Name);
      for (const name of ['AUTH_JWT_SECRET', 'AUTH_OTP_PEPPER', 'AUTH_FIELD_KEY', 'DB_PASSWORD', 'COLLECTIONS_WEBHOOK_SECRET']) {
        expect(envNames).not.toContain(name);
        expect(secretNames).toContain(name);
      }
      expect(c.ReadonlyRootFilesystem).toBe(true);
    }
  });

  it('API can write and read only the contracts prefix of the archive, and knows where signers go', () => {
    const policies = JSON.stringify(staging.app.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('/contracts/*');
    expect(policies).not.toContain('s3:DeleteObject');
    const defs = JSON.stringify(staging.app.findResources('AWS::ECS::TaskDefinition'));
    expect(defs).toContain('https://api.example.com/sign/');
    expect(defs).toContain('CONTRACTS_BUCKET');
  });

  it('runs the daily job at 00:05 Lagos and alerts when it fails', () => {
    staging.app.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(5 23 * * ? *)' });
    staging.app.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ 'detail-type': ['ECS Task State Change'] }),
    });
  });

  it('rolls back failed deployments', () => {
    staging.app.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    });
  });
});

describe('edge', () => {
  it('rate-limits auth endpoints per IP', () => {
    staging.waf.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'auth-rate-limit',
          Statement: { RateBasedStatement: Match.objectLike({ Limit: 100, AggregateKeyType: 'IP' }) },
        }),
      ]),
    });
  });

  it('reaches the API through a VPC origin, never caches, redirects to HTTPS', () => {
    staging.edge.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    staging.edge.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('serves the console from a private bucket under /console with a strict CSP', () => {
    staging.edge.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
    staging.edge.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    staging.edge.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/app*', ViewerProtocolPolicy: 'redirect-to-https' }),
          Match.objectLike({ PathPattern: '/console*', ViewerProtocolPolicy: 'redirect-to-https' }),
          Match.objectLike({ PathPattern: '/sign*', ViewerProtocolPolicy: 'redirect-to-https' }),
        ]),
      }),
    });
    staging.edge.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'") }),
        }),
      }),
    });
  });

  it('production uses its own domain with TLS 1.2+', () => {
    prod.edge.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['api.example.com'],
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }),
      }),
    });
  });
});

describe('console SPA rewrite function', () => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const handler = new Function(`${SPA_REWRITE}; return handler;`)() as (e: { request: { uri: string } }) => {
    uri?: string;
    statusCode?: number;
  };
  const run = (uri: string) => handler({ request: { uri } });

  it.each([
    ['/console/', '/console/index.html'],
    ['/console/accounts/FA-000123', '/console/index.html'],
    ['/console/approvals', '/console/index.html'],
    ['/console/assets/index-abc.js', '/console/assets/index-abc.js'],
    ['/console/assets/index-abc.css', '/console/assets/index-abc.css'],
    ['/sign/', '/sign/index.html'],
    ['/app/accounts/FA-000007', '/app/index.html'],
    ['/app/assets/index-abc.js', '/app/assets/index-abc.js'],
    ['/sign/assets/index-abc.js', '/sign/assets/index-abc.js'],
    ['/v1/health', '/v1/health'],
  ])('%s -> %s', (uri, expected) => {
    expect(run(uri).uri).toBe(expected);
  });

  it('redirects /console and /sign to their trailing-slash form', () => {
    expect(run('/console').statusCode).toBe(301);
    expect(run('/sign').statusCode).toBe(301);
    expect(run('/app').statusCode).toBe(301);
  });
});
