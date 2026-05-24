# FirstTrace on Oracle Cloud Infrastructure

This directory contains the reusable OCI deployment path for FirstTrace. It is
intended for real deployments, not a one-off environment.

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
Secrets are synced after the Vault exists by running `npm run oci:sync-secrets`.

## Deploy With OCI Resource Manager

1. Build the project locally:

   ```bash
   npm ci
   npm run typecheck
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

5. Build and push the container image to OCIR. Authenticate Docker to the
   region's OCIR registry first with an OCI auth token, then run:

   ```bash
   ./deploy/oci/scripts/build-and-push.sh <region-key> <namespace> firsttrace latest
   ```

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
FIRSTTRACE_AI_PROVIDER
FIRSTTRACE_INVESTIGATOR
FIRSTTRACE_RECEIVER_TOKEN
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_INSTALLATION_ID
```

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
