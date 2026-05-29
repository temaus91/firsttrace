# FirstTrace Hosted Setup Instructions

This guide describes the npm-first hosted setup for a company that wants
FirstTrace connected to a private GitHub repository and a Slack triage channel.

FirstTrace supports both a Vercel/Supabase hosted backend and an OCI hosted
backend. Both deployment paths start from the published npm package. This guide
focuses on the Vercel/Supabase setup; OCI setup is documented in
`deploy/oci/README.md`.

## Target Workflow

Vercel/Supabase hosted path:

```text
Slack channel
  -> npm wrapper on Vercel
  -> Supabase job queue
  -> FirstTrace worker
  -> GitHub provider + AI provider
  -> Slack thread reply
```

OCI hosted path:

```text
Slack channel
  -> OCI HTTPS receiver
  -> OCI Queue
  -> FirstTrace worker container
  -> GitHub provider + AI provider
  -> Slack thread reply
```

The setup should work for any company by changing only config values and
environment secrets. Company names, Slack channels, GitHub repositories, and
ownership mappings must not be hardcoded in FirstTrace source code.

## Prerequisites

For the Vercel/Supabase path:

- A small operations wrapper that depends on `firsttrace` from npm.
- A Vercel project for the wrapper's receiver/API service.
- A Supabase project for job, status, and result storage.
- The Supabase CLI for applying packaged migrations.
- Terraform for creating/configuring the Vercel project and production
  environment variables.

For the OCI path, use `deploy/oci/README.md` to create the OCI queue, runtime
containers, Object Storage markers, Vault/KMS secrets, OCIR image, and public
HTTPS entrypoint.

For both hosted paths:

- Slack workspace admin access.
- GitHub organization or repository admin access for installing a GitHub App.
- AI provider access. Use `OPENAI_API_KEY` for direct OpenAI deployments, or
  OCI IAM/resource-principal access for `FIRSTTRACE_AI_PROVIDER=oci-genai`.

## 1. Create the Slack Triage Channel

Create a dedicated channel for AI triage, for example:

```text
company-ai-triage
```

Capture the Slack channel id, such as:

```text
C0123456789
```

Use the channel id in FirstTrace config. Channel names can change, but channel
ids are stable. The Slack channel name should remain config data, not source
code.

## 2. Create the Slack App

If your organization requires backend registration before connecting an app to
Slack, register FirstTrace in the relevant service catalog first. Keep this
organization-neutral: application name, service owner, public base URL, Slack
event/callback URL, OAuth or resource-server requirements if any, data
classification, and whether end-user login is involved.

Create a Slack app for FirstTrace and install it into the workspace.

Recommended initial bot scopes:

- `chat:write`
- `app_mentions:read`

Recommended initial bot event subscription:

- `app_mention`

Validate the Slack app manifest before installing or changing it:

```bash
firsttrace slack validate-manifest \
  --profile slack-minimal \
  --manifest slack-app-manifest.yaml
```

Add broader scopes only when the matching trigger is explicitly enabled in
config:

- top-level public channel messages: `message.channels` plus `channels:history`
- top-level private channel messages: `message.groups` plus `groups:history`
- emoji-triggered investigations: `reaction_added` plus `reactions:read`

Keep `include_thread_context: false` unless the channel is approved to send full
thread context to FirstTrace. Use `data_classification: restricted` for channels
that must never call AI even if someone enables the runtime AI switch.
AI calls also pass through a safety layer. The default
`FIRSTTRACE_AI_SAFETY_MODE=redact` redacts common credentials and skips AI for
PHI, PCI, legal/dispute, or customer production-data markers. Use
`FIRSTTRACE_AI_DRY_RUN=true` to inspect the sanitized report path without
calling the configured model provider.

After deployment, configure Slack event subscriptions to the deployed receiver
URL:

```text
https://your-firsttrace-service.example.com/api/slack/events
```

Slack requires a public HTTPS receiver for real workspace events. Local
verification can still exercise the same receiver code with a synthetic signed
Slack event before OCI, Vercel, or another host is connected. Socket Mode is not
required for FirstTrace and should stay off by default for hosted deployments.

FirstTrace also exposes the generic hosted receiver:

```text
POST https://your-firsttrace-service.example.com/api/investigations
GET  https://your-firsttrace-service.example.com/api/jobs?id=<job-id>
```

Optional advanced event subscriptions:

- `message.channels` for public triage channels
- `message.groups` for private triage channels
- `reaction_added` if emoji-triggered investigations are enabled

Store these values as backend secrets:

```text
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
```

After installing the app, invite it to the configured triage channel.

The Slack provider must verify request signatures, acknowledge events quickly,
and enqueue long-running investigations instead of doing repo analysis inside
the Slack request handler.

## 3. Create the GitHub App

Create a GitHub App for FirstTrace and install it only on the repositories that
FirstTrace is allowed to inspect. FirstTrace uses the app installation to create
short-lived read tokens at runtime and materialize configured repositories under
ignored `.firsttrace/github/`.

Recommended default permissions:

- Contents: read-only
- Metadata: read-only
- Pull requests: read-only, optional
- Issues: read-only, optional

Store these values as backend secrets:

```text
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
```

The private key should be stored in the host secret manager or environment
variable store. Do not commit it into the repository.

If the private key is stored as a single-line environment variable, escaped
newlines such as `\n` are supported.

For local validation only, a personal GitHub token can be used instead:

```text
GITHUB_TOKEN=
```

The token must have read access to the configured repository. Prefer the GitHub
App path for hosted deployments because it can be limited to only the
repositories FirstTrace should inspect.

## 4. Create the Vercel/Supabase Wrapper

Create a small operations directory, install FirstTrace from npm, and copy the
packaged Vercel template:

```bash
mkdir firsttrace-vercel
cd firsttrace-vercel
npm init -y
npm install firsttrace@0.1.4
cp -R node_modules/firsttrace/deploy/vercel/* .
cp node_modules/firsttrace/deploy/vercel/gitignore.template .gitignore
npm install
```

Edit `firsttrace.config.yaml` in the wrapper with the Slack channel id, GitHub
repository, and ownership routing for your organization. Do not put secrets in
that file.

The copied template contains Vercel API routes that import from the npm package:

```text
api/slack/events.js
api/investigations.js
api/jobs.js
api/worker/run-once.js
api/health.js
```

It also contains `public/.gitkeep`, so API-only Vercel builds have a public
output directory.

## 5. Create the Supabase Project

Use Supabase to store investigation jobs, job status, attempts, and results.

Apply all packaged FirstTrace migrations in order with the Supabase CLI:

```bash
mkdir -p supabase/migrations
cp node_modules/firsttrace/supabase/migrations/*.sql supabase/migrations/
supabase link --project-ref "<supabase-project-ref>"
supabase db push
```

This creates `firsttrace_jobs`, enables row level security, and adds the
`firsttrace_claim_next_job()` RPC used by workers to claim queued work
atomically. Later migrations add `dedupe_key` so Slack retries return the
existing queued job instead of creating duplicate investigations and make empty
worker claims return no job cleanly.

Store these values as backend secrets:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

The service role key should only be available to trusted backend and worker
processes. It should not be exposed to browsers, Slack clients, or public config.

## 6. Create the Vercel Project And Environment

Use the packaged Terraform in the wrapper to create or configure the Vercel
project and production environment:

```bash
export VERCEL_API_TOKEN="<vercel-token>"
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. Store secret values only in `production_secrets`;
Terraform state and `terraform.tfvars` should be treated as secret material.

```bash
terraform init
terraform fmt -check
terraform validate
terraform apply
cd ..
```

The Terraform defaults include:

```text
FIRSTTRACE_QUEUE_PROVIDER=supabase
FIRSTTRACE_CONFIG_PATH=firsttrace.config.yaml
FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER=false
FIRSTTRACE_BUILD_REF=npm:firsttrace@0.1.4
FIRSTTRACE_SLACK_REPLY_FORMAT=compact-v1
```

Configure these provider secrets in `production_secrets`:

```text
FIRSTTRACE_RECEIVER_TOKEN=
CRON_SECRET=
FIRSTTRACE_AI_PROVIDER=openai
FIRSTTRACE_AI_ENABLED=false
FIRSTTRACE_INVESTIGATOR=agent
FIRSTTRACE_MODEL_CHAT=gpt-5.4-mini
OPENAI_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

The generic hosted HTTP receiver fails closed unless `FIRSTTRACE_RECEIVER_TOKEN`
is configured. Set `FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER=true` only for
local development when bearer auth is intentionally disabled.

The receiver should validate incoming Slack events, check whether the channel is
configured, dedupe Slack retries before creating duplicate jobs, create a
Supabase-backed job, and return quickly. The worker should process the job
asynchronously and post the result back through the chat provider.

## 7. Deploy The Vercel Wrapper

Link the wrapper directory to the Terraform-created project and deploy:

```bash
npx vercel@latest link --yes --project "$(terraform -chdir=terraform output -raw project_name)"
npx vercel@latest --prod
```

Set the Slack app Event Subscription request URL to:

```text
https://<your-vercel-host>/api/slack/events
```

The Slack endpoint schedules one hosted worker pass with Vercel background
processing after the event has been acknowledged. Keep a protected worker
endpoint available for manual repair runs or for cron on plans that support the
desired frequency:

```text
GET|POST /api/worker/run-once
```

Manual repair runs can call the same endpoint with either `CRON_SECRET` or
`FIRSTTRACE_RECEIVER_TOKEN` as a bearer token. On Vercel,
`FIRSTTRACE_GITHUB_CACHE_ROOT` should point at `/tmp/firsttrace/github` or be
left unset so the worker uses `/tmp` instead of the read-only deployment
directory for GitHub clones.

Before Slack is wired, test the generic hosted receiver directly:

curl -X POST "$FIRSTTRACE_BASE_URL/api/investigations" \
  -H "authorization: Bearer $FIRSTTRACE_RECEIVER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"report":"README deployment plan is unclear","aiEnabled":false}'
```

Run live acceptance from the wrapper directory:

```bash
npx firsttrace hosted accept \
  --backend vercel-supabase \
  --base-url "$FIRSTTRACE_VERCEL_BASE_URL" \
  --config firsttrace.config.yaml \
  --channel "$SLACK_AI_TRIAGE_CHANNEL_ID" \
  --report "README deployment plan is unclear" \
  --expected-build-ref "npm:firsttrace@0.1.4"
```

Acceptance posts a seed Slack message, sends the same signed Slack event twice,
requires the duplicate event to resolve to the same job id, polls job status,
and requires exactly one processing reply and one final Slack reply. It uses the
configured `message` trigger when present and falls back to `app_mention`.

## 8. Configure FirstTrace

Use a config file to connect providers, repositories, channels, triggers, and
ownership routing.

Example:

```yaml
organization:
  name: ExampleCo

investigator:
  provider_env: FIRSTTRACE_INVESTIGATOR
  ai_provider_env: FIRSTTRACE_AI_PROVIDER
  model_env: FIRSTTRACE_MODEL_CHAT

runtime:
  provider: vercel

queue:
  provider: supabase

chat:
  provider: slack
  channels:
    - id: C0123456789
      name: company-ai-triage
      triggers:
        - message
        - app_mention
        - reaction
      repositories:
        - primary-app
      response: thread
      ai_enabled: false
      data_classification: internal
      include_thread_context: false

repos:
  - name: primary-app
    provider: github
    owner: exampleco
    repo: web-app
    default_branch: main

docs:
  - README.md
  - docs

owners:
  - path: app/**
    owner: "@frontend-platform"
  - path: packages/api/**
    owner: "@backend-platform"

search:
  max_files: 10
  max_commits: 8
  max_evidence_per_file: 3
```

All values above are examples. A real deployment should use the company's own
Slack channel id, repository owner/name, ownership paths, and provider choices.

## 9. Expected User Flow

1. A user posts a bug report in the configured Slack triage channel.
2. Slack sends the event to the FirstTrace receiver.
3. The receiver verifies the Slack signature and checks the configured channel.
4. The receiver creates an investigation job in the selected backend queue.
5. The worker gathers GitHub evidence from the configured repository.
6. The configured investigator reasons over gathered evidence and citations.
7. FirstTrace stores the result and replies in the Slack thread.

The Slack reply should stay compact: classification, likely owner, primary
files, confidence, a one- or two-sentence likely cause, next checks, and up to
three implementer/commit/file evidence signals.

## Verification Checklist

- `hosted verify --queue filesystem` passes with the generic local example.
- For Vercel/Supabase deployments,
  `firsttrace hosted accept --backend vercel-supabase` passes against the
  deployed Vercel URL.
- For OCI deployments, `firsttrace hosted accept --backend oci` passes against
  the deployed API Gateway URL.
- Slack event URL is verified successfully.
- The FirstTrace app is installed in the configured channel.
- A test bug report in the configured channel creates a queued job.
- The job moves from queued to running to succeeded.
- The worker can read the configured private GitHub repository.
- The Slack reply includes cited evidence.
- Duplicate Slack event delivery does not create duplicate processing or final
  replies.
- A message from an unconfigured Slack channel is ignored or safely declined.
- No secrets appear in git history, logs, or public config files.

## Security Defaults

- Use read-only repository access by default.
- Store secrets in Vercel, Supabase, OCI Vault, or another host secret manager.
- Keep Slack channel ids, repository names, and ownership mappings in config.
- Do not log full source files by default.
- Keep AI evidence bundles bounded and inspectable.
- Rotate Slack, GitHub, Supabase, OCI, and AI provider credentials if exposed.
