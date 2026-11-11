# AWS SAM and Lambda container packaging

Status: infrastructure definition and Dockerfile only. Nothing has been deployed.
Handler tests already cover application logic with simulated external services;
they do not validate Linux packaging, IAM permissions, API Gateway or SQS delivery.

## Files and scope

- `template.yaml`: HTTP API, three Lambda functions, Standard SQS + DLQ, IAM
  policies, seven-day logs and a DLQ alarm.
- `backend/Dockerfile`: one multi-stage Linux/Node.js 22 image definition reused
  for all functions. SAM ImageConfig selects the appropriate exported handler.
- `backend/.dockerignore`: allowlists build inputs, excluding local secrets,
  node_modules, tests and existing compiled output.
- `backend/tsconfig.lambda.json`: compiles the three entrypoints and their imports,
  not Express startup, archived MCP servers or tests. The normal build is unchanged.

These are three on-demand Lambda functions, not three permanently running servers.
No ECS, EC2, VPC, NAT Gateway, load balancer, provisioned concurrency or frontend
hosting is provisioned here. Supabase remains external. GitHub Actions comes later.

## Parameters for a later deployment

| Parameter | Value |
| --- | --- |
| FrontendOrigin | Exact frontend origin without trailing slash; localhost is allowed for local work. |
| SupabaseUrl | Existing HTTPS Supabase project URL. |
| BackendSecretArn | ARN of an existing Secrets Manager JSON secret (see below). |
| EmbeddingModel | Existing EMBEDDING_MODEL; must match the database vectors. |
| RecommendationModel | Existing RECOMMENDATION_MODEL. |
| SeriesRecommendationModel | Existing OPENAI_MODEL. |
| SeriesSearchModel | Existing OPENAI_MODEL_NON_REASONING. |
| EnableSubmissions | false by default; explicitly set true only after readiness checks. |

The secret JSON must contain SUPABASE_API_KEY and OPENAI_API_KEY. Do not commit
values, put them in Docker ARG/ENV/COPY, or paste them into shell history. No
secret is created by this template. CloudFormation resolves its dynamic references
into Lambda environment variables at deploy/update time. The deployment role needs
GetSecretValue (and decrypt access for a customer-managed key if used); Lambda
roles do not fetch the secret themselves. Only the worker receives OPENAI_API_KEY.
Restrict access to Lambda configuration too, because resolved secrets live there.
Changing the secret alone does not refresh existing Lambda environment variables;
update the function configuration through the stack when rotating credentials.

Secrets Manager storage, ECR image storage, logs and alarms can have charges even
with little application traffic. This is not a zero-cost guarantee. Set billing
alerts and remove unused resources/images when the experiment ends; evaluate their
current prices before deployment. API throttling is not a hard spending cap.

## Queue and access settings

- Worker timeout 240s < database lease 300s; SQS visibility 1440s (6 * timeout).
  A failed message can take 24 minutes to return. Keep these settings aligned.
- Batch size 1, ReportBatchItemFailures, maximum SQS-trigger concurrency 2.
- DLQ after 5 receives; source retention 4 days, DLQ retention 14 days.
  The DLQ alarm has no notification action yet: wire notifications before production.
  Moving to DLQ does not mark a database job failed; recovery still needs attention.
- Submit can only send to this queue; worker can poll it; status has no SQS policy.
  SAM-generated roles also have basic CloudWatch logging permissions.
- Status authorization uses the per-job bearer token, not AWS credentials.
  CORS permits Content-Type and Authorization from one frontend origin.
- POST is deliberately blocked initially (reserved concurrency 0). Enabling
  submissions removes that block. POST is throttled to 1 request/sec, burst 2;
  other routes default to 5/sec, burst 10. Anonymous paid-job creation still needs
  abuse controls and a budget decision before sharing a public URL.
- Apply all three database migrations, including access-token hashes, before use.

## Later local verification (not deployment)

Install AWS SAM CLI and use Docker Desktop in **Linux containers** mode. From the
repository root, validate and build:

```powershell
sam validate --lint --template-file template.yaml --region eu-central-1
sam build --template-file template.yaml
```

SAM builds image functions using Docker; --use-container is unnecessary for this
image-based build. Building pulls base images and npm packages but does not deploy
the application. One Dockerfile is reused; SAM may build/tag it for each function.
The first build needs network access. Use x86_64/Linux images to match the template.

An independent Docker packaging check is also possible:

```powershell
docker build --platform linux/amd64 --provenance=false -t movie-app-lambda:local ./backend
```

Do not run npm start as the container entrypoint. Lambda runs the exported handler
through the AWS base image runtime. Windows-specific host dependencies are never
copied; npm installs Linux dependencies inside the build stages.

After preparing a gitignored `sam-env.local.json` with per-function environment
overrides, the future local HTTP check is:

```powershell
sam local start-api --template .aws-sam/build/template.yaml --env-vars sam-env.local.json --port 3002
```

Choose another port if occupied. Local overrides must supply actual or mocked
service settings; SAM local does not resolve Secrets Manager references or emulate
SQS/Supabase. A successful POST with real configuration sends a real SQS message;
a worker invocation with real model credentials can incur OpenAI costs. Local
HTTP emulation alone does not poll SQS or automatically run the worker. Local
Docker execution does not prove Lambda IAM, cloud timeouts or SQS wiring work.
The current frontend still uses the synchronous response; polling comes later.

No deploy command is part of this step. A later SAM deployment must publish image
artifacts to ECR, provide parameters, acknowledge IAM creation and verify the
CloudFormation change set before creating resources.

## References

- [SAM image builds](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-using-build.html)
- [Lambda Node.js container images](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html)
- [SAM HTTP API](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-httpapi.html)
- [Secrets Manager dynamic references](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html)
