#!/bin/bash
# AI Sales Agent — CDK deploy wrapper.
#
# Required env:
#   AWS_ACCOUNT_ID   — target AWS account id
#   AWS_REGION       — target region (defaults to ap-south-1)
#
# Optional CDK context:
#   -c certificateArn=<arn>   ACM cert for ALB HTTPS listener
#   -c imageTag=<tag>         ECR image tag (defaults to "latest")
#   -c alertEmail=<email>     Email subscribed to the monitoring SNS topic
#   -c stage=production       "production" (default) / "staging" / "dev"

set -e

: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
: "${AWS_REGION:=ap-south-1}"

echo "Deploying AI Sales Agent to AWS..."
echo "  account: ${AWS_ACCOUNT_ID}"
echo "  region:  ${AWS_REGION}"

cd "$(dirname "$0")/../cdk"

npm install --silent
npm run build

echo ""
echo "Step 1/2 — cdk bootstrap"
npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"

echo ""
echo "Step 2/2 — cdk deploy --all"
npx cdk deploy --all --require-approval never "$@"

echo ""
echo "Deployment complete."
echo "Next: Add your API keys to Secrets Manager (see docs/secrets-setup.md)"
