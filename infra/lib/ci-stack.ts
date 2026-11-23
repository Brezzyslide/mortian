import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface CiStackProps extends StackProps {
  /** owner/repo, e.g. "Brezzyslide/mortian" */
  readonly githubRepo: string;
}

/**
 * GitHub OIDC provider + a deploy role that only workflows on this repo's main branch
 * (and the staging/production environments) can assume. No long-lived AWS keys.
 * The role can only assume the CDK bootstrap roles, which do the actual deployment.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    // Native CloudFormation resource: no custom-resource Lambda needed.
    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new iam.Role(this, 'GitHubDeployRole', {
      roleName: `${id}-github-deploy`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.githubRepo}:ref:refs/heads/main`,
            `repo:${props.githubRepo}:environment:staging`,
            `repo:${props.githubRepo}:environment:production`,
          ],
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
