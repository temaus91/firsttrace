# FirstTrace Hosted Setup Instructions

This guide describes the target hosted setup for a company that wants FirstTrace
connected to a private GitHub repository and a Slack triage channel.

Current implementation status: the local CLI, AI-assisted local investigation,
eval runner, local worker runtime, local `submit` message adapter, hosted
Vercel-compatible receiver/status handlers, Supabase-backed queue, and GitHub
App repository provider, Slack Events provider, and hosted readiness verifier
exist. Full live hosted dogfood still requires a configured Slack app, Supabase
project, GitHub App, and worker environment.

## Target Workflow

```text
Slack channel
  -> Vercel receiver
  -> Supabase job queue
  -> FirstTrace worker
  -> GitHub provider + AI provider
  -> Slack thread reply
```

The setup should work for any company by changing only config values and
environment secrets. Company names, Slack channels, GitHub repositories, and
ownership mappings must not be hardcoded in FirstTrace source code.

## Prerequisites

- A Vercel project for the FirstTrace receiver/API service.
- A Supabase project for job, status, and result storage.
- Slack workspace admin access.
- GitHub organization or repository admin access for installing a GitHub App.
- An AI provider API key, with OpenAI as the first supported provider.

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

Recommended initial scopes:

- `chat:write`
- `channels:read`
- `channels:history`
- `app_mentions:read`
- `groups:read` if the triage channel is private
- `groups:history` if the triage channel is private
- `reactions:read` if emoji-triggered investigations are enabled

Configure Slack event subscriptions to the deployed receiver URL:

```text
https://your-firsttrace-service.example.com/api/slack/events
```

FirstTrace also exposes the generic hosted receiver:

```text
POST https://your-firsttrace-service.example.com/api/investigations
GET  https://your-firsttrace-service.example.com/api/jobs?id=<job-id>
```

Recommended initial event subscriptions:

- `app_mention`
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

## 4. Create the Supabase Project

Use Supabase to store investigation jobs, job status, attempts, and results.

Apply the FirstTrace schema from:

```text
supabase/migrations/0001_firsttrace_jobs.sql
```

This creates `firsttrace_jobs`, enables row level security, and adds the
`firsttrace_claim_next_job()` RPC used by workers to claim queued work
atomically.

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
FIRSTTRACE_AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL_CHAT=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=
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

Before the full Slack app is wired, test the generic hosted receiver directly:

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

ai:
  provider: openai
  model_env: OPENAI_MODEL_CHAT

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
      ai_enabled: true

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
6. The AI provider reasons over the gathered evidence and citations.
7. FirstTrace stores the result and replies in the Slack thread.

The Slack reply should include likely files, likely owner or implementer context,
confidence, citations, suggested next steps, and missing-info questions when the
report is underspecified.

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
