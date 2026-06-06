provider "vercel" {
  team = var.vercel_team_id != "" ? var.vercel_team_id : null
}

locals {
  runtime_environment = merge(
    {
      FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER = "false"
      FIRSTTRACE_BUILD_REF                      = "npm:firsttrace@0.1.6"
      FIRSTTRACE_CONFIG_PATH                    = "firsttrace.config.yaml"
      FIRSTTRACE_QUEUE_PROVIDER                 = "supabase"
      FIRSTTRACE_SLACK_REPLY_FORMAT             = "compact-v1"
    },
    var.production_environment,
  )
  production_secret_keys = toset(nonsensitive(keys(var.production_secrets)))
}

resource "vercel_project" "firsttrace" {
  name = var.project_name
}

resource "vercel_project_environment_variable" "runtime" {
  for_each = local.runtime_environment

  project_id = vercel_project.firsttrace.id
  key        = each.key
  value      = each.value
  target     = ["production"]
  sensitive  = false
}

resource "vercel_project_environment_variable" "secrets" {
  for_each = local.production_secret_keys

  project_id = vercel_project.firsttrace.id
  key        = each.value
  value      = var.production_secrets[each.value]
  target     = ["production"]
  sensitive  = true
}
