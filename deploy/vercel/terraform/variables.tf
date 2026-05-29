variable "vercel_team_id" {
  type        = string
  description = "Optional Vercel team id or slug. Leave empty for the authenticated personal account."
  default     = ""
}

variable "project_name" {
  type        = string
  description = "Vercel project name for the FirstTrace wrapper deployment."
  default     = "firsttrace"
}

variable "production_environment" {
  type        = map(string)
  description = "Non-secret production environment variables."
  default     = {}
}

variable "production_secrets" {
  type        = map(string)
  description = "Sensitive production environment variables. Treat Terraform state as secret material."
  sensitive   = true
  default     = {}
}
