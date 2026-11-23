import { App } from 'aws-cdk-lib';
import { CiStack } from '../lib/ci-stack.js';
import { CoreStack } from '../lib/core-stack.js';

const app = new App();

const slug: string = app.node.tryGetContext('projectSlug');
const githubRepo: string = app.node.tryGetContext('githubRepo');
const region: string = app.node.tryGetContext('region');
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = account ? { account, region } : { region };

// One-time: lets GitHub Actions deploy via OIDC. Deployed manually once by the founder.
new CiStack(app, `${slug}-ci`, { env, githubRepo });

for (const stage of ['staging', 'prod'] as const) {
  new CoreStack(app, `${slug}-${stage}-core`, { env, stage, slug });
}

app.synth();
