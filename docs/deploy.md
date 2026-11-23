# Deployment setup

Everything is in `infra/` (AWS CDK). Nothing is created by hand in the console except the one-time steps below.

## Region

Default in `infra/cdk.json` is `af-south-1` (Cape Town). It is an **opt-in region**: enable it under AWS account settings → Regions before bootstrapping. Change `region` in `cdk.json` to deploy elsewhere.

## One-time setup (founder, ~10 minutes)

1. Sign in to the AWS account and open CloudShell in the chosen region.
2. Clone the repo and install: `git clone https://github.com/Brezzyslide/mortian && cd mortian && corepack enable && pnpm install && pnpm build`
3. Bootstrap CDK: `cd infra && npx cdk bootstrap`
4. Deploy the CI role: `npx cdk deploy project-name-ci`
5. Copy the `DeployRoleArn` output into GitHub → repo Settings → Secrets and variables → Actions → variable `AWS_DEPLOY_ROLE_ARN`.

After that, deploy workflows assume the role through GitHub OIDC. No AWS access keys are stored anywhere.
