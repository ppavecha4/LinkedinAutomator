/**
 * AI stack — secrets, Cognito, Bedrock model IAM, KMS.
 *
 * This stack does NOT create an Anthropic client — it just provisions the
 * secrets and IAM surface that the compute-stack services need.
 */

import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  Mfa,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
} from 'aws-cdk-lib/aws-cognito';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AiSecrets {
  readonly anthropicApiKey: Secret;
  readonly apolloApiKey: Secret;
  readonly twilioAccountSid: Secret;
  readonly twilioAuthToken: Secret;
  readonly linkedinAccessToken: Secret;
  readonly calendlyApiKey: Secret;
}

export class AiStack extends Stack {
  public readonly secrets: AiSecrets;
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly kmsKey: Key;
  /**
   * Literal model id requested in the Session 4 spec. Bedrock's catalogue
   * uses its own model ids (e.g. `anthropic.claude-3-sonnet-...`) and this
   * exact string may need to be swapped for the Bedrock equivalent once
   * model access is enrolled in the target account. Tracked in memory.
   */
  public readonly bedrockModelId = 'anthropic.claude-sonnet-4-20250514';

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.kmsKey = new Key(this, 'AiKey', {
      enableKeyRotation: true,
      description: 'AI Sales Agent — Cognito + Secrets encryption',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ----- Secrets Manager -----
    // NOTE: using the AWS-managed `aws/secretsmanager` KMS key (no
    // encryptionKey prop). Using a customer-managed key here creates a
    // cross-stack cycle: compute-stack's taskRole gets a grantRead on each
    // secret which needs a key policy grant, and that grant lives on the
    // key in this stack → cycle back to compute. AWS-managed keys don't
    // need explicit key policy grants for services in the same account.
    const make = (id: string, name: string, hint: string): Secret =>
      new Secret(this, id, {
        secretName: name,
        description: hint,
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
      });

    this.secrets = {
      anthropicApiKey: make(
        'AnthropicApiKey',
        '/sales-agent/anthropic-api-key',
        'Anthropic API key for Claude Sonnet',
      ),
      apolloApiKey: make(
        'ApolloApiKey',
        '/sales-agent/apollo-api-key',
        'Apollo.io prospecting API key',
      ),
      twilioAccountSid: make(
        'TwilioAccountSid',
        '/sales-agent/twilio-account-sid',
        'Twilio account SID (WhatsApp)',
      ),
      twilioAuthToken: make(
        'TwilioAuthToken',
        '/sales-agent/twilio-auth-token',
        'Twilio auth token (WhatsApp)',
      ),
      linkedinAccessToken: make(
        'LinkedInAccessToken',
        '/sales-agent/linkedin-access-token',
        'LinkedIn partner API OAuth2 access token',
      ),
      calendlyApiKey: make(
        'CalendlyApiKey',
        '/sales-agent/calendly-api-key',
        'Calendly personal access token + webhook signing key',
      ),
    };

    // ----- Cognito user pool (admin-created users) -----
    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: 'sales-agent-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: false },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { sms: true, otp: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'sales-agent-dashboard-spa',
      generateSecret: false, // SPA client — public, PKCE
      authFlows: {
        userSrp: true,
        custom: true,
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
  }
}
