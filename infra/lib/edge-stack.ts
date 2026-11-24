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
  /**
   * Single-page apps served from the web bucket under /<prefix>/: the staff console and the
   * signing page. A missing dist folder creates the route but uploads nothing.
   */
  readonly webApps?: readonly { readonly prefix: WebPrefix; readonly distPath: string }[];
}

/** CloudFront Function (viewer request): client-side routes get the app shell; files pass through. */
/** Path prefixes served as single-page apps from the web bucket. */
export const WEB_PREFIXES = ['app', 'console', 'sign'] as const;
export type WebPrefix = (typeof WEB_PREFIXES)[number];

export const SPA_REWRITE = `
function handler(event) {
  var r = event.request;
  var app = r.uri.split('/')[1];
  if (app !== 'app' && app !== 'console' && app !== 'sign') return r;
  if (r.uri === '/' + app) {
    return { statusCode: 301, statusDescription: 'Moved', headers: { location: { value: '/' + app + '/' } } };
  }
  if (!r.uri.split('/').pop().includes('.')) r.uri = '/' + app + '/index.html';
  return r;
}`;

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:", // blob: lets staff view an ID photo fetched with their session
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

    // ---------------- Web apps (console, signing page) ----------------
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
        contentSecurityPolicy: { contentSecurityPolicy: WEB_CSP, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(site);

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
      additionalBehaviors: Object.fromEntries(
        WEB_PREFIXES.map((prefix) => [
          `/${prefix}*`,
          {
            origin: webOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            responseHeadersPolicy: consoleHeaders,
            functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
          },
        ]),
      ),
    });

    for (const web of props.webApps ?? []) {
      if (!existsSync(web.distPath)) {
        Annotations.of(this).addWarning(`${web.prefix} not built (${web.distPath} missing): run \`pnpm build\` before deploying.`);
        continue;
      }
      const id = { app: 'App', console: 'Console', sign: 'Sign' }[web.prefix];
      // Hashed assets cache for a year; index.html is always revalidated so a deploy shows at once.
      new deploy.BucketDeployment(this, `${id}Assets`, {
        sources: [deploy.Source.asset(web.distPath, { exclude: ['index.html'] })],
        destinationBucket: site,
        destinationKeyPrefix: `${web.prefix}/`,
        cacheControl: [deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
        prune: false,
      });
      new deploy.BucketDeployment(this, `${id}Index`, {
        sources: [deploy.Source.asset(web.distPath, { exclude: ['*', '!index.html'] })],
        destinationBucket: site,
        destinationKeyPrefix: `${web.prefix}/`,
        cacheControl: [deploy.CacheControl.fromString('no-cache')],
        prune: false,
        distribution: this.distribution,
        distributionPaths: [`/${web.prefix}/index.html`],
      });
    }

    const base = `https://${props.domain?.name ?? this.distribution.distributionDomainName}`;
    new CfnOutput(this, 'ApiUrl', { value: base });
    new CfnOutput(this, 'ConsoleUrl', { value: `${base}/console/` });
    new CfnOutput(this, 'SigningUrl', { value: `${base}/sign/` });
    new CfnOutput(this, 'CustomerAppUrl', { value: `${base}/app/` });
    new CfnOutput(this, 'CloudFrontDomain', { value: this.distribution.distributionDomainName });
  }
}
