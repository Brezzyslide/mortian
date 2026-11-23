import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';

export interface EdgeStackProps extends StackProps {
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly webAclArn: string;
  /** Custom domain and its ACM certificate (must be in us-east-1). Required for production. */
  readonly domain?: { readonly name: string; readonly certificateArn: string };
}

/**
 * Public HTTPS entry point. CloudFront reaches the internal load balancer through a VPC origin
 * (a private connection into the VPC), so the API has no public IP or listener of its own.
 * Without a domain it uses the default *.cloudfront.net certificate, whose TLS policy cannot be
 * raised above TLSv1: acceptable for staging only. Production is refused without a domain.
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const origin = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: undefined,
    });

    this.distribution = new cloudfront.Distribution(this, 'Api', {
      comment: 'API',
      webAclId: props.webAclArn,
      ...(props.domain
        ? {
            domainNames: [props.domain.name],
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', props.domain.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // includes edge locations in Africa
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // every API response is per-user
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    });

    new CfnOutput(this, 'ApiUrl', { value: `https://${props.domain?.name ?? this.distribution.distributionDomainName}` });
    new CfnOutput(this, 'CloudFrontDomain', { value: this.distribution.distributionDomainName });
  }
}
