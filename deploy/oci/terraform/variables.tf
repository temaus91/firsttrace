variable "tenancy_ocid" {
  description = "Tenancy OCID. OCI Resource Manager usually provides this value automatically."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment OCID where FirstTrace runtime resources are created."
  type        = string
}

variable "region" {
  description = "OCI region identifier, for example us-ashburn-1."
  type        = string
}

variable "project_name" {
  description = "Short lowercase prefix used for OCI display names."
  type        = string
  default     = "firsttrace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.project_name))
    error_message = "project_name must be 3-31 lowercase letters, numbers, or hyphens and start with a letter."
  }
}

variable "container_image_url" {
  description = "Full image URL to run. Leave empty on the first apply, then set after pushing the image to OCIR."
  type        = string
  default     = ""
}

variable "config_path" {
  description = "Config file path inside the container image."
  type        = string
  default     = "firsttrace.config.yaml"
}

variable "runtime_secret_names" {
  description = "Comma-separated Vault secret names the runtime must load. Add optional tuning env vars here only when you also create matching Vault secrets."
  type        = string
  default     = "FIRSTTRACE_RECEIVER_TOKEN,SLACK_SIGNING_SECRET,SLACK_BOT_TOKEN,GITHUB_APP_ID,GITHUB_APP_PRIVATE_KEY,GITHUB_APP_INSTALLATION_ID"
}

variable "ai_provider" {
  description = "AI model provider. Use oci-genai for OCI-native model inference, or openai for direct OpenAI API use."
  type        = string
  default     = "oci-genai"

  validation {
    condition     = contains(["oci-genai", "openai"], var.ai_provider)
    error_message = "ai_provider must be oci-genai or openai."
  }
}

variable "ai_model" {
  description = "Chat model id used by the selected AI provider. For OCI GenAI, choose a model available in the configured region."
  type        = string
  default     = "openai.gpt-oss-120b"
}

variable "oci_genai_dedicated_endpoint_id" {
  description = "Optional OCI GenAI dedicated endpoint OCID. Leave empty to use on-demand serving with ai_model."
  type        = string
  default     = ""
}

variable "vcn_cidr" {
  description = "CIDR for the runtime VCN."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR for the runtime subnet."
  type        = string
  default     = "10.42.10.0/24"
}

variable "shape" {
  description = "OCI Container Instance shape."
  type        = string
  default     = "CI.Standard.E4.Flex"
}

variable "ocpus" {
  description = "OCPUs assigned to the container instance."
  type        = number
  default     = 1
}

variable "memory_gbs" {
  description = "Memory assigned to the container instance."
  type        = number
  default     = 4
}

variable "queue_retention_seconds" {
  description = "OCI Queue message retention. Maximum supported value is 7 days."
  type        = number
  default     = 604800
}

variable "queue_visibility_seconds" {
  description = "Visibility timeout while the worker processes one investigation."
  type        = number
  default     = 900
}

variable "queue_poll_timeout_seconds" {
  description = "Long-poll timeout for OCI Queue receive calls."
  type        = number
  default     = 20
}
