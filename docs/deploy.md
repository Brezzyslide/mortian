# Deployment

Everything is in `infra/` (AWS CDK) and deploys from GitHub Actions. The only console work is the one-time setup below.

## What gets deployed (per environment)

| Stack | Contents |
| --- | --- |
| `network` | VPC over 2 AZs: public (NAT only), private (load balancer, API), isolated (database). Rejected-traffic flow logs |
| `core` | KMS key; contracts archive bucket with Object Lock (7-year compliance in production) |
| `data` | Postgres 16 on RDS: encrypted, private, TLS forced. Generated secrets for JWT, OTP pepper, field key, webhook secret |
| `app` | API on Fargate behind an **internal** load balancer; migrations on boot; CPU autoscaling; deployment rollback; daily arrears job at 00:05 Lagos; alert topic for job failures |
| `waf` (us-east-1) | WAF for CloudFront: 100 requests / 5 min per IP on `/v1/auth/*` and on `/v1/sign/*`, 2,000 / 5 min overall, AWS IP-reputation, known-bad-inputs and common rule sets |
| `edge` | CloudFront: API via a private VPC origin (no caching) the staff console at `/console/` and the signing page at `/sign/` from a private bucket, HTTPS only |

The API has no public IP or listener. Its only way in is CloudFront → VPC origin → internal load balancer, and the load balancer accepts only CloudFront's origin-facing addresses.

| | Staging | Production |
| --- | --- | --- |
| Database | t4g.micro, single AZ, 7-day backups | t4g.small, multi-AZ, 30-day backups, deletion protection |
| API | 1 task (0.25 vCPU, 512 MB), up to 2 | 2 tasks (0.5 vCPU, 1 GB), up to 6 |
| NAT gateways | 1 | 2 |
| Address | default `*.cloudfront.net` | **your domain required** (TLS 1.2+) |
| Deploys | automatically after CI passes on `main` | by hand, with approval |

Staging cost: roughly US$100–150 a month in Cape Town, mostly the NAT gateway, load balancer and database. Confirm with the AWS pricing calculator before relying on this.

## One-time setup (founder, about 20 minutes)

1. **Enable Cape Town:** AWS console → account menu → Account → AWS Regions → enable **Africa (Cape Town)**. It is opt-in.
2. **Open CloudShell** in af-south-1 and run:
   ```sh
   git clone https://github.com/Brezzyslide/mortian && cd mortian
   corepack enable && pnpm install && pnpm build
   cd infra
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   npx cdk bootstrap aws://$ACCOUNT/af-south-1 aws://$ACCOUNT/us-east-1
   npx cdk deploy project-name-ci
   ```
   us-east-1 is needed because CloudFront's WAF must live there.
3. **GitHub → repo Settings → Environments:** create `staging`, and `production` with yourself as required reviewer.
4. **GitHub → Settings → Secrets and variables → Actions → Variables:**
   - `AWS_DEPLOY_ROLE_ARN` = the `DeployRoleArn` output from step 2
   - `AWS_REGION` = `af-south-1`
   - `ALERT_EMAIL` = where job-failure alerts go (confirm the subscription email AWS sends)
5. Push to `main` or run **Deploy** by hand. The job prints the API and console URLs.
6. Set the variable `STAGING_PUBLIC_BASE_URL` to the printed API URL (e.g. `https://d123.cloudfront.net`) and deploy again. Contract signing links are built from it; until it is set, issuing a contract returns "not configured".

## First admin

After the first staging deploy, run the create-admin command once as a one-off task. Cluster, task definition, subnet and security group names are in the `app` stack outputs and console:

```sh
aws ecs run-task --cluster <ClusterName> --launch-type FARGATE \
  --task-definition <DailyJobTask family> \
  --network-configuration "awsvpcConfiguration={subnets=[<private subnet>],securityGroups=[<AppSg>]}" \
  --overrides '{"containerOverrides":[{"name":"job","command":["node","dist/cli/create-admin.js"],
    "environment":[{"name":"ADMIN_EMAIL","value":"you@company.com"},{"name":"ADMIN_NAME","value":"Your Name"},
                   {"name":"ADMIN_PASSWORD","value":"<at least 12 characters>"}]}]}'
```

Task overrides are visible to anyone in the account who can describe ECS tasks; today that is only you. Then open the console URL from the deploy output, sign in and scan the QR code into an authenticator app. Invite everyone else from console → Staff.

## Production

Production stacks are only defined once a domain exists:

1. Request an ACM certificate **in us-east-1** for e.g. `api.yourdomain.com` and validate it by DNS.
2. Set the variables `PROD_DOMAIN` and `PROD_CERTIFICATE_ARN`.
3. Run **Deploy** with target `production` and approve it.
4. Point a DNS CNAME from the domain to the `CloudFrontDomain` output.

The API refuses to start in production while SMS or collections are still sandbox, so production cannot go live until those providers are chosen.

## Not yet in infrastructure

- Hosting for the customer PWA and signing app. The console is served at `/console/` (see console.md).
- Database secret rotation. Not enabled yet, because the API reads credentials at start-up; it will be added with a reload-on-rotation path. The field-encryption key must **never** be rotated without re-encrypting TOTP secrets.
