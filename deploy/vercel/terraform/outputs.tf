output "project_id" {
  description = "Vercel project id."
  value       = vercel_project.firsttrace.id
}

output "project_name" {
  description = "Vercel project name."
  value       = vercel_project.firsttrace.name
}

output "expected_build_ref" {
  description = "Build ref expected by firsttrace hosted accept."
  value       = local.runtime_environment.FIRSTTRACE_BUILD_REF
}
