# FirstTrace on Oracle Cloud Infrastructure

This directory contains the reusable OCI deployment path for FirstTrace. It is
intended for real deployments, not a one-off environment.

The preferred runtime image is package-based: `deploy/oci/Dockerfile.package`
installs the `firsttrace` npm package tarball and copies one deployment config
file into the image. OCI still runs Container Instances, but the image no longer
needs the full FirstTrace source tree at runtime.

## What Terraform Creates

- OCI Queue for investigation jobs
- Object Storage bucket for job, dedupe, processing, and final-reply markers
- OCI Vault and KMS key for runtime secrets
- OCIR container repository for the FirstTrace image
- VCN, subnet, security list, and internet gateway for the runtime
- Dynamic group and policy for container resource-principal access
- Container Instance with a receiver container and worker container
- API Gateway in front of the receiver

The Terraform does not store real Slack, GitHub, or OpenAI secrets in state.
Secrets are synced after the Vault exists by running `firsttrace-oci-sync-secrets`
from the npm package, or `npm run oci:sync-secrets` from a source checkout.

## Deploy With OCI Resource Manager

1. Prepare a FirstTrace package tarball and deployment config:

   ```bash
   npm pack
   cp firsttrace.config.yaml firsttrace.oci.config.yaml
   ```

2. Create a zip of `deploy/oci/terraform` and upload it as an OCI Resource
   Manager stack.

3. Set stack variables:

   ```text
   tenancy_ocid
   compartment_ocid
   region
   project_name = firsttrace
   container_image_url = ""
   ```

4. Apply once. This creates the base infrastructure and OCIR repository.

5. Build and push the package image to OCIR. Authenticate Docker to the
   region's OCIR registry first with an OCI auth token, then run:

   ```bash
   export FIRSTTRACE_DOCKERFILE="deploy/oci/Dockerfile.package"
   export FIRSTTRACE_PACKAGE_TARBALL="$(ls firsttrace-*.tgz | tail -n 1)"
   export FIRSTTRACE_CONFIG_FILE="firsttrace.oci.config.yaml"
   export FIRSTTRACE_CONFIG_DEST="firsttrace.config.yaml"
   export FIRSTTRACE_CONTAINER_PLATFORM="linux/amd64"

   ./deploy/oci/scripts/build-and-push.sh <region-key> <namespace> firsttrace latest
   ```

   The script builds `linux/amd64` by default because OCI Container Instances
   expose AMD shapes in some regions. Override with
   `FIRSTTRACE_CONTAINER_PLATFORM=<platform>` only when your selected shape
   supports that architecture.

   The final image URL should look like:

   ```text
   <region-key>.ocir.io/<namespace>/firsttrace:latest
   ```

6. Export the secret-sync outputs from Terraform, then sync local runtime
   secrets into OCI Vault:

   ```bash
   export OCI_COMPARTMENT_ID="<terraform output secret_sync_env.OCI_COMPARTMENT_ID>"
   export OCI_REGION="<terraform output secret_sync_env.OCI_REGION>"
   export OCI_VAULT_ID="<terraform output secret_sync_env.OCI_VAULT_ID>"
   export OCI_VAULT_KEY_ID="<terraform output secret_sync_env.OCI_VAULT_KEY_ID>"

   npm run oci:sync-secrets
   ```

7. Set `container_image_url` in the Resource Manager stack and apply again.

8. Open the Slack app Event Subscriptions page and set the request URL to the
   `slack_events_url` Terraform output.

9. Verify:

   ```bash
   curl "$(terraform output -raw health_url)"
   ```

   Then post a report in the configured Slack channel. FirstTrace should post
   one processing reply and one final investigation reply in the same thread.

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
export FIRSTTRACE_VERSION="0.1.0"
export IMAGE_TAG="${FIRSTTRACE_VERSION}"
```

Prepare the package, Terraform files, image script, and config file. After
FirstTrace is published to npm, `npm pack firsttrace@"$FIRSTTRACE_VERSION"` is
enough. Before public publish, run `npm pack` from a release/source checkout and
upload the resulting tarball instead.

```bash
mkdir -p ~/firsttrace
cd ~/firsttrace
npm pack firsttrace@"$FIRSTTRACE_VERSION"
tar -xzf "firsttrace-${FIRSTTRACE_VERSION}.tgz" package/deploy/oci
cp -R package/deploy/oci ./deploy/oci
cp "firsttrace-${FIRSTTRACE_VERSION}.tgz" firsttrace-package.tgz
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
export FIRSTTRACE_CONTAINER_PLATFORM="linux/amd64"
export FIRSTTRACE_DOCKERFILE="deploy/oci/Dockerfile.package"
export FIRSTTRACE_PACKAGE_TARBALL="firsttrace-package.tgz"
export FIRSTTRACE_CONFIG_FILE="firsttrace.config.yaml"
export FIRSTTRACE_CONFIG_DEST="firsttrace.config.yaml"

./deploy/oci/scripts/build-and-push.sh \
  "$OCI_REGION_KEY" \
  "$OCI_NAMESPACE" \
  "$OCI_REPOSITORY" \
  "$IMAGE_TAG"
```

Sync runtime secrets into OCI Vault. The sync command reads a local `.env` file;
do not commit this file or place it in Terraform variables.

In Cloud Shell, use **Cloud Shell menu -> Upload** to upload your local
`.env.local` as `~/firsttrace.env.local`, then move it into place:

```bash
mv -f ~/firsttrace.env.local ~/firsttrace/.env.local
chmod 600 ~/firsttrace/.env.local
```

```bash
cd ~/firsttrace/deploy/oci/terraform

export OCI_COMPARTMENT_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_COMPARTMENT_ID')"
export OCI_REGION="$(terraform output -json secret_sync_env | jq -r '.OCI_REGION')"
export OCI_VAULT_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_VAULT_ID')"
export OCI_VAULT_KEY_ID="$(terraform output -json secret_sync_env | jq -r '.OCI_VAULT_KEY_ID')"

cd ~/firsttrace
npm install --prefix ~/firsttrace/tools ./firsttrace-package.tgz
PATH="$HOME/firsttrace/tools/node_modules/.bin:$PATH" firsttrace-oci-sync-secrets
rm -f ~/firsttrace/.env.local ~/firsttrace.env.local
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

Verify the deployed endpoints:

```bash
export HEALTH_URL="$(terraform output -raw health_url)"
export SLACK_EVENTS_URL="$(terraform output -raw slack_events_url)"

curl "$HEALTH_URL"
printf 'Slack Events URL: %s\n' "$SLACK_EVENTS_URL"
```

Set the Slack app Event Subscriptions request URL to `SLACK_EVENTS_URL`, save
the Slack app config, and post a report in the configured channel.

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
OPENAI_API_KEY
OPENAI_MODEL_CHAT
FIRSTTRACE_RECEIVER_TOKEN
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_INSTALLATION_ID
```

Optional runtime tuning values such as `FIRSTTRACE_AI_PROVIDER` and
`FIRSTTRACE_INVESTIGATOR` use code defaults when omitted. Add them to
`runtime_secret_names` only when you also create matching Vault secrets.

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
