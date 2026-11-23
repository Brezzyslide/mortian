import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface CoreStackProps extends StackProps {
  readonly stage: 'staging' | 'prod';
  readonly slug: string;
}

/**
 * Phase 0 core: encryption key and the contracts archive.
 * Network, RDS, ECS, SQS and edge stacks are added in Phase 1.
 */
export class CoreStack extends Stack {
  readonly dataKey: kms.Key;
  readonly contractsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${props.slug}-${props.stage}-data`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Executed contracts and evidence certificates. Object Lock in COMPLIANCE mode means
    // no one — including the account root — can delete or overwrite a locked version
    // before retention expires. Staging uses GOVERNANCE so test data can be cleared.
    this.contractsBucket = new s3.Bucket(this, 'ContractsArchive', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: isProd
        ? s3.ObjectLockRetention.compliance(Duration.days(365 * 7))
        : s3.ObjectLockRetention.governance(Duration.days(1)),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'ContractsBucketName', { value: this.contractsBucket.bucketName });
  }
}
