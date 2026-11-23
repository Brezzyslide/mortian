import { existsSync } from 'node:fs';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

export interface EdgeStackProps extends StackProps {
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly webAclArn: string;
  /** Custom domain and its ACM certificate (must be in us-east-1). Required for production. */
  readonly domain?: { readonly name: string; readonly certificateArn: string };
  /** Built console (apps/console/dist). When missing, the bucket is created but nothing is uploaded. */
  readonly consoleDistPath?: string;
}

/** CloudFront Function (viewer request): client-side routes get the app shell; files pass through. */
export const SPA_REWRITE = `
function handler(event) {
  var r = event.request;
  if (r.uri === '/console') {
    return { statusCode: 301, statusDescription: 'Moved', headers: { location: { value: '/console/' } } };
  }
  if (!r.uri.split('/').pop().includes('.')) r.uri = '/console/index.html';
  return r;
}`;

const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * One public HTTPS address for the API (/v1/*) and the staff console (/console/*), so the console
 * calls the API same-origin and tokens never cross domains. CloudFront reaches the internal load
 * balancer through a VPC origin; the console comes from a private bucket readable only by this
 * distribution.
 * Without a domain it uses the default *.cloudfront.net certificate, whose TLS policy cannot be
 * raised above TLSv1: acceptable for staging only. Production is refused without a domain.
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const api = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: api,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // every API response is per-user
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    };

    // ---------------- Console ----------------
    const site = new s3.Bucket(this, 'ConsoleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Client-side routes (/console/accounts/FA-000123) serve the app shell.
    const spaRewrite = new cloudfront.Function(this, 'ConsoleSpa', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
    });

    const consoleHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ConsoleHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONSOLE_CSP, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Api', {
      comment: 'API and staff console',
      webAclId: props.webAclArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // includes edge locations in Africa
      ...(props.domain
        ? {
            domainNames: [props.domain.name],
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', props.domain.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      defaultBehavior: apiBehavior,
      additionalBehaviors: {
        '/console*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(site),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: consoleHeaders,
          functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
      },
    });

    if (props.consoleDistPath && existsSync(props.consoleDistPath)) {
      // Hashed assets cache for a year; index.html is always revalidated so a deploy shows at once.
      new deploy.BucketDeployment(this, 'ConsoleAssets', {
        sources: [deploy.Source.asset(props.consoleDistPath, { exclude: ['index.html'] })],
        destinationBucket: site,
        destinationKeyPrefix: 'console/',
        cacheControl: [deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
        prune: false,
      });
      new deploy.BucketDeployment(this, 'ConsoleIndex', {
        sources: [deploy.Source.asset(props.consoleDistPath, { exclude: ['*', '!index.html'] })],
        destinationBucket: site,
        destinationKeyPrefix: 'console/',
        cacheControl: [deploy.CacheControl.fromString('no-cache')],
        prune: false,
        distribution: this.distribution,
        distributionPaths: ['/console/index.html'],
      });
    } else {
      Annotations.of(this).addWarning('Console not built (apps/console/dist missing): run `pnpm build` before deploying.');
    }

    const base = `https://${props.domain?.name ?? this.distribution.distributionDomainName}`;
    new CfnOutput(this, 'ApiUrl', { value: base });
    new CfnOutput(this, 'ConsoleUrl', { value: `${base}/console/` });
    new CfnOutput(this, 'CloudFrontDomain', { value: this.distribution.distributionDomainName });
  }
}
