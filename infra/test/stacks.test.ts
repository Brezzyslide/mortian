import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CiStack } from '../lib/ci-stack.js';
import { CoreStack } from '../lib/core-stack.js';

const env = { account: '111111111111', region: 'af-south-1' };

describe('CoreStack', () => {
  it('prod contracts archive uses Object Lock COMPLIANCE, KMS and blocks public access', () => {
    const t = Template.fromStack(new CoreStack(new App(), 'core-prod', { env, stage: 'prod', slug: 'p' }));
    t.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'COMPLIANCE' } } },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) }),
        ],
      },
    });
  });

  it('staging uses GOVERNANCE so test data can be cleared', () => {
    const t = Template.fromStack(new CoreStack(new App(), 'core-stg', { env, stage: 'staging', slug: 'p' }));
    t.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockConfiguration: { Rule: { DefaultRetention: { Mode: 'GOVERNANCE' } } },
    });
  });
});

describe('CiStack', () => {
  it('deploy role trusts only this repo main branch and its environments', () => {
    const t = Template.fromStack(new CiStack(new App(), 'ci', { env, githubRepo: 'Brezzyslide/mortian' }));
    t.resourceCountIs('AWS::Lambda::Function', 0);
    const roles = t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'ci-github-deploy' } });
    expect(Object.keys(roles)).toHaveLength(1);
    const trust = JSON.stringify(Object.values(roles)[0]);
    expect(trust).toContain('repo:Brezzyslide/mortian:ref:refs/heads/main');
    expect(trust).toContain('repo:Brezzyslide/mortian:environment:production');
    expect(trust).not.toContain('repo:Brezzyslide/mortian:*');
  });
});
