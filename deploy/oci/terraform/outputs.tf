output "api_gateway_url" {
  description = "Public API Gateway URL. Use /api/slack/events as the Slack Event Subscription request URL."
  value       = length(oci_apigateway_deployment.runtime) == 0 ? null : oci_apigateway_deployment.runtime[0].endpoint
}

output "slack_events_url" {
  description = "Slack Event Subscription request URL."
  value       = length(oci_apigateway_deployment.runtime) == 0 ? null : "${trimsuffix(oci_apigateway_deployment.runtime[0].endpoint, "/")}/api/slack/events"
}

output "health_url" {
  description = "Runtime health check URL."
  value       = length(oci_apigateway_deployment.runtime) == 0 ? null : "${trimsuffix(oci_apigateway_deployment.runtime[0].endpoint, "/")}/healthz"
}

output "container_repository_name" {
  description = "OCIR repository name created for the FirstTrace image."
  value       = oci_artifacts_container_repository.image.display_name
}

output "container_repository_namespace" {
  description = "OCIR namespace used in image URLs."
  value       = oci_artifacts_container_repository.image.namespace
}

output "queue_id" {
  description = "OCI Queue OCID."
  value       = oci_queue_queue.jobs.id
}

output "queue_messages_endpoint" {
  description = "OCI Queue messages endpoint used by the runtime."
  value       = oci_queue_queue.jobs.messages_endpoint
}

output "state_bucket_name" {
  description = "Object Storage bucket used for job, dedupe, and Slack reply markers."
  value       = oci_objectstorage_bucket.state.name
}

output "objectstorage_namespace" {
  description = "Object Storage namespace."
  value       = data.oci_objectstorage_namespace.current.namespace
}

output "vault_id" {
  description = "OCI Vault OCID used for runtime secrets."
  value       = oci_kms_vault.secrets.id
}

output "vault_key_id" {
  description = "KMS key OCID used to encrypt runtime secrets."
  value       = local.kms_key_id
}

output "secret_sync_env" {
  description = "Environment variables required by npm run oci:sync-secrets."
  value = {
    OCI_COMPARTMENT_ID = local.compartment_id
    OCI_REGION         = var.region
    OCI_VAULT_ID       = oci_kms_vault.secrets.id
    OCI_VAULT_KEY_ID   = local.kms_key_id
  }
}
