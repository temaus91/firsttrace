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

variable "secret_profile" {
  description = "Named runtime Vault secret profile: bootstrap, slack-minimal, github-repos, or direct-openai. Ignored when runtime_secret_names is set."
  type        = string
  default     = "github-repos"

  validation {
    condition     = contains(["bootstrap", "slack-minimal", "github-repos", "direct-openai"], var.secret_profile)
    error_message = "secret_profile must be bootstrap, slack-minimal, github-repos, or direct-openai."
  }
}

variable "runtime_secret_names" {
  description = "Optional comma-separated Vault secret names override. Leave empty to use secret_profile."
  type        = string
  default     = ""
}

variable "enable_vault_secret_loading" {
  description = "Load runtime secrets from OCI Vault. Set false for bootstrap health checks before secrets are created."
  type        = bool
  default     = true
}

variable "oci_vault_secrets_required" {
  description = "Fail startup when a configured OCI Vault secret is missing. Set false only for bootstrap or UAT flows."
  type        = bool
  default     = true
}

variable "existing_kms_key_ocid" {
  description = "Optional existing OCI Vault KMS key OCID for runtime secrets. Leave empty to create a new AES-256 key in the FirstTrace Vault."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.existing_kms_key_ocid) == "" || startswith(trimspace(var.existing_kms_key_ocid), "ocid1.key.")
    error_message = "existing_kms_key_ocid must be empty or an OCI KMS key OCID starting with ocid1.key."
  }
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

variable "ai_enabled" {
  description = "Allow hosted Slack-originated jobs to call the selected AI provider when channel config also sets ai_enabled: true."
  type        = bool
  default     = false
}

variable "ai_model" {
  description = "Chat model id used by the selected AI provider. For OCI GenAI, choose a model available in the configured region."
  type        = string
  default     = "openai.gpt-5-codex"
}

variable "oci_genai_dedicated_endpoint_id" {
  description = "Optional OCI GenAI dedicated endpoint OCID. Leave empty to use on-demand serving with ai_model."
  type        = string
  default     = ""
}

variable "oci_genai_region" {
  description = "Optional OCI GenAI inference region. Leave empty to use the runtime region. Set this when queues/runtime run in a region that does not host the selected model."
  type        = string
  default     = ""
}

variable "ai_output_token_limit" {
  description = "Optional output token limit passed to the selected AI provider. Leave empty to let the provider choose."
  type        = string
  default     = ""
}

variable "ai_output_token_limit_field" {
  description = "Request field for ai_output_token_limit. Use auto, none, or an explicit provider field path such as maxCompletionTokens."
  type        = string
  default     = "auto"
}

variable "ai_temperature" {
  description = "Optional temperature value passed to the selected AI provider. Leave empty to omit."
  type        = string
  default     = ""
}

variable "ai_temperature_field" {
  description = "Request field for ai_temperature. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_reasoning_effort" {
  description = "Optional reasoning-effort value passed to providers that support it."
  type        = string
  default     = ""
}

variable "ai_reasoning_effort_field" {
  description = "Request field for ai_reasoning_effort. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_verbosity" {
  description = "Optional verbosity value passed to providers that support it."
  type        = string
  default     = ""
}

variable "ai_verbosity_field" {
  description = "Request field for ai_verbosity. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_top_p" {
  description = "Optional top_p value passed to the selected AI provider. Leave empty to omit."
  type        = string
  default     = ""
}

variable "ai_top_p_field" {
  description = "Request field for ai_top_p. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_top_k" {
  description = "Optional top_k value passed to the selected AI provider. Leave empty to omit."
  type        = string
  default     = ""
}

variable "ai_top_k_field" {
  description = "Request field for ai_top_k. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_stop_sequences" {
  description = "Optional comma-separated or JSON-array stop sequences passed to the selected AI provider. Leave empty to omit."
  type        = string
  default     = ""
}

variable "ai_stop_sequences_field" {
  description = "Request field for ai_stop_sequences. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_store" {
  description = "Optional store flag passed to providers that support it. Use true or false, or leave empty to omit."
  type        = string
  default     = ""
}

variable "ai_store_field" {
  description = "Request field for ai_store. Use auto, none, or an explicit provider field path."
  type        = string
  default     = "auto"
}

variable "ai_request_extra_json" {
  description = "Optional JSON object deep-merged into the final provider request. A null value removes that key."
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
