# FirstTrace Hosted Setup Instructions

This guide describes the target hosted setup for a company that wants FirstTrace
connected to a private GitHub repository and a Slack triage channel.

Current implementation status: the local CLI, AI-assisted local investigation,
eval runner, local worker runtime, local `submit` message adapter, hosted
Vercel-compatible receiver/status handlers, Supabase-backed queue, and GitHub
App repository provider, Slack Events provider, and hosted readiness verifier
exist. FirstTrace currently supports both a Vercel/Supabase hosted backend and
an OCI hosted backend. This guide focuses on the Vercel/Supabase setup; OCI
setup is documented in `deploy/oci/README.md`.

Full live Vercel/Supabase deployment still requires a configured Slack app,
Supabase project, GitHub App, and worker environment. Full live OCI deployment
requires the same Slack/GitHub/AI configuration plus the OCI resources described
in the OCI deployment guide.

## Target Workflow

Vercel/Supabase hosted path:

```text
Slack channel
  -> Vercel receiver
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

- A Vercel project for the FirstTrace receiver/API service.
- A Supabase project for job, status, and result storage.

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

Configure Slack event subscriptions to the deployed receiver URL:

```text
https://your-firsttrace-service.example.com/api/slack/events
```

Slack requires a public HTTPS receiver for real workspace events. Local
verification can still exercise the same receiver code with a synthetic signed
Slack event before Vercel or another host is connected.

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

## 4. Create the Supabase Project

Use Supabase to store investigation jobs, job status, attempts, and results.

Apply all FirstTrace migrations in order from:

```text
supabase/migrations/
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

## 5. Deploy the Vercel Backend

Deploy the FirstTrace receiver/API service to Vercel and configure environment
variables for the selected providers:

```text
FIRSTTRACE_CONFIG_PATH=
FIRSTTRACE_QUEUE_PROVIDER=supabase
FIRSTTRACE_RECEIVER_TOKEN=
FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER=false
CRON_SECRET=
FIRSTTRACE_GITHUB_CACHE_ROOT=
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

For standalone Vercel deployments, the Slack endpoint can schedule one hosted
worker pass with Vercel background processing after the event has been
acknowledged. Keep a protected worker endpoint available for manual repair runs
or for cron on plans that support the desired frequency:

```text
GET|POST /api/worker/run-once
```

Manual repair runs can call the same endpoint with either `CRON_SECRET` or
`FIRSTTRACE_RECEIVER_TOKEN` as a bearer token. On Vercel,
`FIRSTTRACE_GITHUB_CACHE_ROOT` should point at `/tmp/firsttrace/github` or be
left unset so the worker uses `/tmp` instead of the read-only deployment
directory for GitHub clones.

Before the full Slack app is wired, test the generic hosted receiver directly:

```bash
firsttrace doctor --config examples/minimal.local.config.yaml
```

This catches missing local repository snapshots, missing Slack signing secrets,
unavailable Slack replies, missing GitHub credentials, and AI provider gaps
before deployment. Deterministic investigation remains available when AI
credentials are missing unless `--ai` or hosted Slack AI is explicitly enabled.

```bash
curl -X POST "$FIRSTTRACE_BASE_URL/api/investigations" \
  -H "authorization: Bearer $FIRSTTRACE_RECEIVER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"report":"README deployment plan is unclear","aiEnabled":false}'
```

Before live external services are ready, test the hosted orchestration path
locally:

```bash
npm run firsttrace -- hosted verify \
  --config examples/hosted.local.config.yaml \
  --queue filesystem \
  --report "README deployment plan is unclear"
```

This sends a synthetic signed Slack event through the receiver, enqueues a job,
runs the worker once, and captures the Slack reply with a fake notifier. It does
not prove live Slack, GitHub App, or Supabase connectivity.

## 6. Configure FirstTrace

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

## 7. Expected User Flow

1. A user posts a bug report in the configured Slack triage channel.
2. Slack sends the event to the FirstTrace receiver.
3. The receiver verifies the Slack signature and checks the configured channel.
4. The receiver creates a Supabase-backed investigation job.
5. The worker gathers GitHub evidence from the configured repository.
6. The configured investigator reasons over gathered evidence and citations.
7. FirstTrace stores the result and replies in the Slack thread.

The Slack reply should include the likely cause, likely files, implementer or
commit context with dates when available, confidence, citations, suggested next
steps, and missing-info questions when the report is underspecified.

## Verification Checklist

- `hosted verify --queue filesystem` passes with the generic local example.
- Slack event URL is verified successfully.
- The FirstTrace app is installed in the configured channel.
- A test bug report in the configured channel creates a queued job.
- The job moves from queued to running to succeeded.
- The worker can read the configured private GitHub repository.
- The Slack reply includes cited evidence.
- A message from an unconfigured Slack channel is ignored or safely declined.
- No secrets appear in git history, logs, or public config files.

## Security Defaults

- Use read-only repository access by default.
- Store secrets in Vercel, Supabase, or another host secret manager.
- Keep Slack channel ids, repository names, and ownership mappings in config.
- Do not log full source files by default.
- Keep AI evidence bundles bounded and inspectable.
- Rotate Slack, GitHub, Supabase, and AI provider credentials if exposed.
