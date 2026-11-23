import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

/**
 * Web ACL for CloudFront. CloudFront-scoped WAF must live in us-east-1, whatever region the
 * application runs in. Per-IP rate limits protect OTP and staff login from brute force and SMS cost abuse.
 */
export class WafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { authRequestsPer5Min?: number; allRequestsPer5Min?: number }) {
    super(scope, id, props);

    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
    });

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'web-acl', sampledRequestsEnabled: true },
      rules: [
        {
          name: 'auth-rate-limit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.authRequestsPer5Min ?? 100,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/v1/auth/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'auth-rate-limit', sampledRequestsEnabled: true },
        },
        {
          name: 'signing-rate-limit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.authRequestsPer5Min ?? 100,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/v1/sign/',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'signing-rate-limit', sampledRequestsEnabled: true },
        },
        {
          name: 'global-rate-limit',
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: props.allRequestsPer5Min ?? 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'global-rate-limit', sampledRequestsEnabled: true },
        },
        managed('AWSManagedRulesAmazonIpReputationList', 3),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 4),
        managed('AWSManagedRulesCommonRuleSet', 5),
      ],
    });

    this.webAclArn = acl.attrArn;
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
  }
}
