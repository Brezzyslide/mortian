import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack.js';
import { CiStack } from '../lib/ci-stack.js';
import { CoreStack } from '../lib/core-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { EdgeStack } from '../lib/edge-stack.js';
import { NetworkStack } from '../lib/network-stack.js';
import { STAGES } from '../lib/stage.js';
import { WafStack } from '../lib/waf-stack.js';

const app = new App();
const consoleDistPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'apps', 'console', 'dist');

const slug: string = app.node.tryGetContext('projectSlug');
const githubRepo: string = app.node.tryGetContext('githubRepo');
const region: string = app.node.tryGetContext('region');
const alertEmail: string | undefined = app.node.tryGetContext('alertEmail') || undefined;
// Production is only defined once a domain and certificate exist:  -c prodDomain=api.example.com -c prodCertificateArn=arn:...
const prodDomain: string | undefined = app.node.tryGetContext('prodDomain') || undefined;
const prodCertificateArn: string | undefined = app.node.tryGetContext('prodCertificateArn') || undefined;
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = account ? { account, region } : { region };
const usEast1 = account ? { account, region: 'us-east-1' } : { region: 'us-east-1' };

// One-time: lets GitHub Actions deploy via OIDC. Deployed manually once by the founder.
new CiStack(app, `${slug}-ci`, { env, githubRepo });

const stages = prodDomain && prodCertificateArn ? [STAGES.staging, STAGES.prod] : [STAGES.staging];

for (const settings of stages) {
  const p = `${slug}-${settings.stage}`;
  const domain = settings.stage === 'prod' ? { name: prodDomain!, certificateArn: prodCertificateArn! } : undefined;
  const network = new NetworkStack(app, `${p}-network`, { env, settings });
  const core = new CoreStack(app, `${p}-core`, { env, stage: settings.stage, slug });
  const data = new DataStack(app, `${p}-data`, {
    env,
    settings,
    vpc: network.vpc,
    dbSg: network.dbSg,
    dataKey: core.dataKey,
  });
  const api = new AppStack(app, `${p}-app`, {
    env,
    settings,
    vpc: network.vpc,
    albSg: network.albSg,
    appSg: network.appSg,
    db: data.db,
    dbName: data.dbName,
    appSecrets: data.appSecrets,
    ...(alertEmail ? { alertEmail } : {}),
  });
  const waf = new WafStack(app, `${p}-waf`, { env: usEast1, crossRegionReferences: true });
  new EdgeStack(app, `${p}-edge`, {
    env,
    crossRegionReferences: true,
    alb: api.alb,
    webAclArn: waf.webAclArn,
    consoleDistPath,
    ...(domain ? { domain } : {}),
  });
}

app.synth();
