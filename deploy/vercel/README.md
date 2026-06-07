# FirstTrace on Vercel and Supabase

This directory is the reusable npm-first Vercel/Supabase deployment template for
FirstTrace. It is meant to be copied from the published npm package into an
operations repository. The deployed runtime imports FirstTrace from npm.

FirstTrace is positioned as a PM/manager-facing manager-owner triage service.
The next version priority is a built-in `manager-owner-triage` response that
identifies the user-facing issue, evidence-backed owner candidates, likely root
cause, user impact, and recommended manager action without requiring a custom
prompt overlay.

## What This Template Provides

- Vercel API routes for Slack Events, generic investigation submission, job
  status, worker run-once, and `/healthz`.
- A minimal `public/.gitkeep` so API-only Vercel builds pass.
- Terraform for Vercel project and production environment variables.
- A placeholder `firsttrace.config.yaml` for repository, Slack channel, and owner
  routing.

Supabase schema migrations are provided by the npm package under
`node_modules/firsttrace/supabase/migrations`. Apply them with the Supabase CLI.

## Install The Template

```bash
mkdir firsttrace-vercel
cd firsttrace-vercel
npm init -y
npm install firsttrace@0.1.7
cp -R node_modules/firsttrace/deploy/vercel/* .
cp node_modules/firsttrace/deploy/vercel/gitignore.template .gitignore
npm install
```

Edit `firsttrace.config.yaml` for your Slack channel, repositories, and owners.
Do not put secrets in that file.

Current package versions support optional prompt overlays in the same file:

```yaml
investigation:
  prompt:
    profile: manager-owner-triage
    overlay_files:
      - ./prompts/company-style.md
```

Overlays are additive. Use them only for local style or domain wording. They
should not be required for the core manager-owner triage workflow, and they
cannot remove FirstTrace safety, citation, or output-schema rules.

## Apply Supabase Migrations

Create or choose a Supabase project, then apply every packaged migration in
order:

```bash
mkdir -p supabase/migrations
cp node_modules/firsttrace/supabase/migrations/*.sql supabase/migrations/
supabase link --project-ref "<supabase-project-ref>"
supabase db push
```

`supabase db push` tracks applied migrations in
`supabase_migrations.schema_migrations` and skips migrations that were already
applied.

## Create Vercel Project And Env

Create a Vercel token and export it for Terraform:

```bash
export VERCEL_API_TOKEN="<vercel-token>"
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` with your Vercel team, project name, and production
secrets. Treat `terraform.tfvars` and Terraform state as secret material.

```bash
terraform init
terraform fmt -check
terraform validate
terraform apply
```

The Terraform defaults set:

```text
FIRSTTRACE_QUEUE_PROVIDER=supabase
FIRSTTRACE_CONFIG_PATH=firsttrace.config.yaml
FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER=false
FIRSTTRACE_BUILD_REF=npm:firsttrace@0.1.7
FIRSTTRACE_SLACK_REPLY_FORMAT=compact-v1
```

Set provider-specific AI request controls in `production_environment` only when
the selected model needs them. For example, use
`FIRSTTRACE_AI_OUTPUT_TOKEN_LIMIT=6000` with
`FIRSTTRACE_AI_OUTPUT_TOKEN_LIMIT_FIELD=maxCompletionTokens` when a provider
expects that token-limit field. The template also supports
`FIRSTTRACE_AI_TEMPERATURE`, `FIRSTTRACE_AI_REASONING_EFFORT`,
`FIRSTTRACE_AI_VERBOSITY`, `FIRSTTRACE_AI_TOP_P`, `FIRSTTRACE_AI_TOP_K`,
`FIRSTTRACE_AI_STOP_SEQUENCES`, `FIRSTTRACE_AI_STORE`, matching `_FIELD`
variables, and `FIRSTTRACE_AI_REQUEST_EXTRA_JSON`.

## Deploy

Link the local wrapper directory to the Terraform-created project and deploy:

```bash
cd ..
npx vercel@latest link --yes --project "$(terraform -chdir=terraform output -raw project_name)"
npx vercel@latest --prod
```

After Vercel prints the production URL, set the Slack app Event Subscription
request URL to:

```text
https://<your-vercel-host>/api/slack/events
```

Leave Socket Mode off for this hosted setup.

## Accept

Run the live acceptance harness from this wrapper directory:

```bash
export FIRSTTRACE_VERCEL_BASE_URL="https://<your-vercel-host>"
export FIRSTTRACE_BUILD_REF="$(terraform -chdir=terraform output -raw expected_build_ref)"
export SLACK_AI_TRIAGE_CHANNEL_ID="<slack-channel-id>"

# Use the same values configured in Vercel.
export FIRSTTRACE_RECEIVER_TOKEN="<receiver-token>"
export SLACK_BOT_TOKEN="<slack-bot-token>"
export SLACK_SIGNING_SECRET="<slack-signing-secret>"

npx firsttrace hosted accept \
  --backend vercel-supabase \
  --base-url "$FIRSTTRACE_VERCEL_BASE_URL" \
  --config firsttrace.config.yaml \
  --channel "$SLACK_AI_TRIAGE_CHANNEL_ID" \
  --report "README deployment plan is unclear" \
  --expected-build-ref "$FIRSTTRACE_BUILD_REF"
```

Expected result: health passes, Slack receives one processing reply and one
final reply, the duplicate signed Slack event returns the same job id, and the
job reaches `succeeded`. The acceptance harness uses the configured `message`
trigger when present and falls back to `app_mention`, so the starter template
works with the minimal Slack app scopes.
