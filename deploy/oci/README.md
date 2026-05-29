# FirstTrace on Oracle Cloud Infrastructure

This directory contains the reusable OCI deployment path for FirstTrace. It is
intended for real deployments, not a one-off environment.

The preferred runtime image is package-based: `deploy/oci/Dockerfile.package`
installs `firsttrace@<version>` from npm and copies one deployment config file
into the image. OCI still runs Container Instances, but the image does not need
the full FirstTrace source tree at runtime.

## What Terraform Creates

- OCI Queue for investigation jobs
- Object Storage bucket for job, dedupe, processing, and final-reply markers
- OCI Vault and KMS key for runtime secrets
- OCIR container repository for the FirstTrace image
- VCN, subnet, security list, and internet gateway for the runtime
- Dynamic group and policy for container resource-principal access
- Container Instance with a receiver container and worker container
- API Gateway in front of the receiver

The Terraform does not store real Slack or GitHub secrets in state.
Secrets are created in OCI Vault after the Vault exists by running
`firsttrace-oci-sync-secrets` from the npm package. Production setup should use
interactive prompts or shell environment variables; `.env.local` is only a local
development convenience. The default OCI deployment uses OCI Generative AI, so
it does not require `OPENAI_API_KEY`.

## Deploy With OCI Resource Manager

1. Create an operations directory and install FirstTrace from npm:

   ```bash
   mkdir firsttrace-oci
   cd firsttrace-oci
   npm init -y
   npm install firsttrace@0.1.2
   cp -R node_modules/firsttrace/deploy/oci ./deploy/oci
   ```

   Then create `firsttrace.oci.config.yaml` in that directory. It should contain
   your repositories, owners, and Slack channel config, but not secrets.

2. Create a zip of `deploy/oci/terraform` and upload it as an OCI Resource
   Manager stack.

3. Set stack variables:

   ```text
   tenancy_ocid
   compartment_ocid
   region
   project_name = firsttrace
   ai_provider = oci-genai
   ai_model = openai.gpt-oss-120b
   container_image_url = ""
   ```

   Pick an `ai_model` that is approved for your tenancy and available in the
   selected OCI region. If you use a dedicated OCI GenAI endpoint, also set
   `oci_genai_dedicated_endpoint_id`.

4. Apply once. This creates the base infrastructure and OCIR repository.

5. Build and push the package image to OCIR. Authenticate Docker to the
   region's OCIR registry first with an OCI auth token, then run:

   ```bash
   export FIRSTTRACE_DOCKERFILE="deploy/oci/Dockerfile.package"
   export FIRSTTRACE_PACKAGE_SPEC="firsttrace@0.1.2"
   export FIRSTTRACE_BUILD_REF="npm:firsttrace@0.1.2"
   export FIRSTTRACE_CONFIG_FILE="firsttrace.oci.config.yaml"
   export FIRSTTRACE_CONFIG_DEST="firsttrace.config.yaml"
   export FIRSTTRACE_CONTAINER_PLATFORM="linux/arm64" # Use linux/amd64 for CI.Standard.E4.Flex.

   ./deploy/oci/scripts/build-and-push.sh <region-key> <namespace> firsttrace latest
   ```

   The script builds the native builder architecture by default. Set
   `FIRSTTRACE_CONTAINER_PLATFORM` to match the selected OCI Container Instance
   shape: `linux/arm64` for `CI.Standard.A1.Flex`, or `linux/amd64` for
   `CI.Standard.E4.Flex`. OCI Cloud Shell commonly runs on ARM, so use the A1
   shape for the simplest Cloud Shell build path. Building AMD64 from an ARM
   Cloud Shell needs a Docker Buildx builder with emulation, not plain Podman.

   The final image URL should look like:

   ```text
   <region-key>.ocir.io/<namespace>/firsttrace:latest
   ```

   If Cloud Shell is ARM but the target region has no `CI.Standard.A1.Flex`
   capacity, build the package image from a Linux AMD64 CI runner instead. This
   repository includes `.github/workflows/package-image.yml` as an example: it
   installs `firsttrace@<version>` from npm and pushes a Linux AMD64 image to
   GHCR. Trigger it from GitHub Actions, then use the resulting image with an
   AMD64 Container Instance shape:

   ```bash
   terraform apply -auto-approve \
     -var='container_image_url=ghcr.io/<owner>/firsttrace:<commit-sha>' \
     -var='shape=CI.Standard.E4.Flex'
   ```

   This keeps the deployed runtime npm-based, but uses GitHub-hosted Docker
   Buildx instead of relying on Cloud Shell cross-architecture emulation.

6. Export the secret-sync outputs from Terraform, then create runtime secrets in
   OCI Vault:

   ```bash
   export OCI_COMPARTMENT_ID="<terraform output secret_sync_env.OCI_COMPARTMENT_ID>"
   export OCI_REGION="<terraform output secret_sync_env.OCI_REGION>"
   export OCI_VAULT_ID="<terraform output secret_sync_env.OCI_VAULT_ID>"
   export OCI_VAULT_KEY_ID="<terraform output secret_sync_env.OCI_VAULT_KEY_ID>"

   npx firsttrace-oci-sync-secrets --prompt
   ```

   The prompt hides secret values, can generate `FIRSTTRACE_RECEIVER_TOKEN`,
   supports multiline `GITHUB_APP_PRIVATE_KEY`, and prints only which secrets
   were synced.

7. Set `container_image_url` in the Resource Manager stack and apply again.

8. Open the Slack app Event Subscriptions page and set the request URL to the
   `slack_events_url` Terraform output.

9. Verify with the live acceptance harness:

   ```bash
   export FIRSTTRACE_OCI_BASE_URL="$(terraform output -raw api_gateway_url)"
   export SLACK_AI_TRIAGE_CHANNEL_ID="<your Slack channel id>"

   # Use the same values that were synced to OCI Vault.
   export FIRSTTRACE_RECEIVER_TOKEN="<receiver token>"
   export SLACK_BOT_TOKEN="<Slack bot token>"
   export SLACK_SIGNING_SECRET="<Slack signing secret>"

   npx firsttrace hosted accept \
     --backend oci \
     --base-url "$FIRSTTRACE_OCI_BASE_URL" \
     --config firsttrace.oci.config.yaml \
     --channel "$SLACK_AI_TRIAGE_CHANNEL_ID" \
     --report "README deployment plan is unclear" \
     --expected-build-ref "npm:firsttrace@0.1.2"
   ```

   This posts a real Slack seed message, sends the same signed event to OCI
   twice, confirms one processing reply and one final reply, checks the job
   status endpoint, and proves OCI Queue redelivery with a temporary queue.

## Cloud Shell Setup Commands

This is the exact installation shape used for the first OCI setup, written with
placeholders so another FirstTrace user can reuse it. Run these commands from
OCI Cloud Shell after signing in to the target tenancy and selecting the target
region.

Set the tenancy and region values:

```bash
export TENANCY_OCID="<tenancy_ocid>"
export COMPARTMENT_OCID="<compartment_ocid>"
export OCI_REGION="<oci-region>"        # Example: us-sanjose-1
export OCI_REGION_KEY="<ocir-region-key>" # Example: sjc
export PROJECT_NAME="firsttrace"
export FIRSTTRACE_VERSION="0.1.2"
export IMAGE_TAG="${FIRSTTRACE_VERSION}"
```

Prepare the Terraform files, image script, and config file from the npm package:

```bash
mkdir -p ~/firsttrace
cd ~/firsttrace
npm init -y
npm install "firsttrace@${FIRSTTRACE_VERSION}"
cp -R node_modules/firsttrace/deploy/oci ./deploy/oci
```

Upload or create your deployment config as `~/firsttrace/firsttrace.config.yaml`.
It should contain your `repos`, `owners`, and Slack channel configuration, but
not secrets.

Create the base OCI infrastructure. Keep `container_image_url` empty for the
first apply because the OCIR repository must exist before the image can be
pushed.

```bash
cd ~/firsttrace/deploy/oci/terraform
cp terraform.tfvars.example terraform.tfvars

python3 - <<'PY'
from pathlib import Path
import os

p = Path("terraform.tfvars")
s = p.read_text()
s = s.replace('tenancy_ocid = ""', f'tenancy_ocid = "{os.environ["TENANCY_OCID"]}"')
s = s.replace('compartment_ocid = ""', f'compartment_ocid = "{os.environ["COMPARTMENT_OCID"]}"')
s = s.replace('region = "us-ashburn-1"', f'region = "{os.environ["OCI_REGION"]}"')
s = s.replace('project_name = "firsttrace"', f'project_name = "{os.environ["PROJECT_NAME"]}"')
s = s.replace('container_image_url = ""', 'container_image_url = ""')
s += '\nshape = "CI.Standard.A1.Flex"\n'
p.write_text(s)
PY

terraform init
terraform fmt -check
terraform validate
terraform apply -auto-approve
```

Capture the Terraform outputs needed by later steps:

```bash
export OCI_NAMESPACE="$(terraform output -raw objectstorage_namespace)"
export OCI_REPOSITORY="$(terraform output -raw container_repository_name)"
export IMAGE_URL="${OCI_REGION_KEY}.ocir.io/${OCI_NAMESPACE}/${OCI_REPOSITORY}:${IMAGE_TAG}"

terraform output
```

Create one OCI auth token and log in to OCIR. OCI only shows the token value at
creation time, and each user can have at most two auth tokens, so do not create
tokens in a retry loop. If setup fails after token creation, delete the stale
FirstTrace token before creating another one.

```bash
export USER_OCID="$(
  oci iam user list \
    --compartment-id "$TENANCY_OCID" \
    --all \
    --query "data[?name=='<oci-login-user>'].id | [0]" \
    --raw-output
)"

oci iam auth-token list \
  --user-id "$USER_OCID" \
  --all \
  --query "data[].{id:id,description:description,\"time-created\":\"time-created\"}"
```

Delete only stale FirstTrace install tokens that you no longer need:

```bash
oci iam auth-token delete \
  --user-id "$USER_OCID" \
  --auth-token-id "<stale_auth_token_ocid>" \
  --force
```

Create a fresh token and immediately use it for registry login:

```bash
export OCIR_AUTH_TOKEN="$(
  oci iam auth-token create \
    --user-id "$USER_OCID" \
    --description "firsttrace-ocir-$(date +%Y%m%d%H%M%S)" \
    --query 'data.token' \
    --raw-output
)"

printf '%s' "$OCIR_AUTH_TOKEN" |
  docker login "${OCI_REGION_KEY}.ocir.io" \
    -u "${OCI_NAMESPACE}/<oci-login-user>" \
    --password-stdin

unset OCIR_AUTH_TOKEN
```

If the CLI-created token is not accepted by OCIR, create the token from the OCI
Console instead: open **My profile -> Tokens and keys -> Auth tokens -> Generate
token**, copy the token once, then run the same `docker login` command. The
token value is not recoverable after the dialog is closed.

For federated users, the OCIR username can include the identity provider:
`${OCI_NAMESPACE}/oracleidentitycloudservice/<oci-login-user>`. For OCI local
users, the username is normally `${OCI_NAMESPACE}/<oci-login-user>`. The local
user currently shown by Cloud Shell appears in the startup text:

```text
You are using Cloud Shell in tenancy <tenancy> as OCI local user <oci-login-user>
```

Build and push the image:

```bash
cd ~/firsttrace
export FIRSTTRACE_CONTAINER_PLATFORM="linux/arm64"
export FIRSTTRACE_DOCKERFILE="deploy/oci/Dockerfile.package"
export FIRSTTRACE_PACKAGE_SPEC="firsttrace@${FIRSTTRACE_VERSION}"
export FIRSTTRACE_CONFIG_FILE="firsttrace.config.yaml"
export FIRSTTRACE_CONFIG_DEST="firsttrace.config.yaml"
export FIRSTTRACE_BUILD_REF="npm:firsttrace@${FIRSTTRACE_VERSION}"

./deploy/oci/scripts/build-and-push.sh \
  "$OCI_REGION_KEY" \
  "$OCI_NAMESPACE" \
  "$OCI_REPOSITORY" \
  "$IMAGE_TAG"
```

If `CI.Standard.A1.Flex` is out of capacity, or if you need an AMD64 image from
an ARM Cloud Shell where Docker Buildx emulation is not available, use the
repository package-image workflow instead of building in Cloud Shell:

```bash
# Push or manually dispatch .github/workflows/package-image.yml.
# After it succeeds, copy the image tag printed by the workflow.
export IMAGE_URL="ghcr.io/<owner>/firsttrace:<commit-sha>"
export OCI_SHAPE="CI.Standard.E4.Flex"
```

Then apply with explicit overrides:

```bash
cd ~/firsttrace/deploy/oci/terraform
terraform apply -auto-approve \
  -var="container_image_url=${IMAGE_URL}" \
  -var="shape=${OCI_SHAPE}"
```

`CI.Standard.E4.Flex` is an AMD64 shape and may consume trial credits or paid
usage. Prefer `CI.Standard.A1.Flex` plus `linux/arm64` when Always Free capacity
is available.

Create runtime secrets in OCI Vault. The production path does not require a
source checkout or `.env.local`; enter values interactively or provide them from
the shell environment. Do not place secret values in Terraform variables.

```bash
cd ~/firsttrace/deploy/oci/terraform

export OCI_COMPARTMENT_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_COMPARTMENT_ID')"
export OCI_REGION="$(terraform output -json secret_sync_env | jq -r '.OCI_REGION')"
export OCI_VAULT_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_VAULT_ID')"
export OCI_VAULT_KEY_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_VAULT_KEY_ID')"

cd ~/firsttrace
npx firsttrace-oci-sync-secrets --prompt
```

If your automation already has secrets in the shell environment, use the default
non-interactive mode instead:

```bash
export FIRSTTRACE_RECEIVER_TOKEN="..."
export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="..."
export GITHUB_APP_ID="..."
export GITHUB_APP_PRIVATE_KEY="..."
export GITHUB_APP_INSTALLATION_ID="..."

npx firsttrace-oci-sync-secrets
```

The default OCI stack uses `FIRSTTRACE_AI_PROVIDER=oci-genai` and
`FIRSTTRACE_MODEL_CHAT` from Terraform variables, not Vault. Set
`ai_model` in `terraform.tfvars` or Resource Manager to a model available in
your selected OCI region. If you intentionally use direct OpenAI instead, set
`ai_provider = "openai"` and add `OPENAI_API_KEY` to `runtime_secret_names`.

For migration from an existing secret file, opt in explicitly:

```bash
npx firsttrace-oci-sync-secrets --env-file ./secrets.env
```

If your Terraform CLI cannot read the object output directly, copy the values
from `terraform output` and export them manually:

```bash
export OCI_COMPARTMENT_ID="<secret_sync_env.OCI_COMPARTMENT_ID>"
export OCI_REGION="<secret_sync_env.OCI_REGION>"
export OCI_VAULT_ID="<secret_sync_env.OCI_VAULT_ID>"
export OCI_VAULT_KEY_ID="<secret_sync_env.OCI_VAULT_KEY_ID>"
```

Apply again with the image URL so Terraform creates the receiver, worker, and
API Gateway:

```bash
cd ~/firsttrace/deploy/oci/terraform

python3 - <<'PY'
from pathlib import Path
import os

p = Path("terraform.tfvars")
s = p.read_text()
s = s.replace('container_image_url = ""', f'container_image_url = "{os.environ["IMAGE_URL"]}"')
p.write_text(s)
PY

terraform apply -auto-approve
```

Verify the deployed endpoints and run live acceptance:

```bash
export FIRSTTRACE_OCI_BASE_URL="$(terraform output -raw api_gateway_url)"
export HEALTH_URL="$(terraform output -raw health_url)"
export SLACK_EVENTS_URL="$(terraform output -raw slack_events_url)"

curl "$HEALTH_URL"
printf 'Slack Events URL: %s\n' "$SLACK_EVENTS_URL"
```

Set the Slack app Event Subscriptions request URL to `SLACK_EVENTS_URL`, save
the Slack app config, then run the acceptance command from the npm package:

```bash
cd ~/firsttrace

export SLACK_AI_TRIAGE_CHANNEL_ID="<your Slack channel id>"

# Use the same values synced to OCI Vault. If you let the prompt generate
# FIRSTTRACE_RECEIVER_TOKEN, store that value in your password manager or rerun
# the secret sync with a known token before running acceptance.
export FIRSTTRACE_RECEIVER_TOKEN="<receiver token>"
export SLACK_BOT_TOKEN="<Slack bot token>"
export SLACK_SIGNING_SECRET="<Slack signing secret>"

npx firsttrace hosted accept \
  --backend oci \
  --base-url "$FIRSTTRACE_OCI_BASE_URL" \
  --config firsttrace.config.yaml \
  --channel "$SLACK_AI_TRIAGE_CHANNEL_ID" \
  --report "README deployment plan is unclear" \
  --expected-build-ref "$FIRSTTRACE_BUILD_REF"
```

Expected result: health passes, Slack receives one processing reply and one
final reply in the seed thread, the duplicate signed Slack event returns the
same job id, the job reaches `succeeded`, and the temporary OCI Queue redelivery
probe passes. The seed thread is left in the Slack channel; no `chat:delete`
scope is required.

## Auth Token Troubleshooting

OCI auth tokens are persistent credentials. The token string is returned only by
`oci iam auth-token create`; `oci iam auth-token list` returns token metadata
and OCIDs, but not the secret token value. OCI allows at most two auth tokens per
user. If you accidentally create unusable tokens, list them, delete the stale
FirstTrace tokens, and create one replacement token.

The commands are:

```bash
oci iam auth-token list --user-id "$USER_OCID" --all

oci iam auth-token delete \
  --user-id "$USER_OCID" \
  --auth-token-id "<stale_auth_token_ocid>" \
  --force

oci iam auth-token create \
  --user-id "$USER_OCID" \
  --description "firsttrace-ocir-$(date +%Y%m%d%H%M%S)"
```

Use `docker login <region-key>.ocir.io`, not a repository path. The repository
path is only used in the image tag, for example:

```bash
docker login sjc.ocir.io -u '<namespace>/<oci-login-user>' --password-stdin
docker push sjc.ocir.io/<namespace>/firsttrace:<tag>
```

## Local Terraform

```bash
cd deploy/oci/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

For local Terraform, authenticate with the standard OCI provider configuration,
for example `~/.oci/config` plus `OCI_CONFIG_PROFILE`.

## Required Runtime Secrets

These are loaded from OCI Vault at startup when present:

```text
FIRSTTRACE_RECEIVER_TOKEN
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_INSTALLATION_ID
```

Provider/runtime tuning values such as `FIRSTTRACE_AI_PROVIDER` and
`FIRSTTRACE_MODEL_CHAT` are supplied as Terraform container environment
variables by default. Add optional values such as `FIRSTTRACE_INVESTIGATOR` or
direct-OpenAI `OPENAI_API_KEY` to `runtime_secret_names` only when you also
create matching Vault secrets.

Use the GitHub App values for production repositories. `GITHUB_TOKEN` is only a
fallback for local or personal deployments; add it to `runtime_secret_names` only
when that fallback is intentional.

## Cost Controls And Teardown

OCI Queue, API Gateway, Container Instances, Vault, and Object Storage may
consume trial credits or paid usage depending on the account and region. Keep
the Resource Manager stack small, set OCI budgets/alerts in the console, and
destroy the stack when you are done:

```bash
terraform destroy
```

Resource Manager users can run Destroy from the stack page.
