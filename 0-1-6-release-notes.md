# FirstTrace 0.1.6 Release Notes

Status: published to npm as `firsttrace@0.1.6`.

## Implemented

- FirstTrace is now positioned as a PM/manager-first manager-owner triage tool,
  not an engineer-first debug chat tool.
- Added generic `provider: git` repository materialization with read-only
  clone/fetch, branch/tag/commit refs, full clone by default, explicit shallow
  clone support, HTTPS token env credentials, SSH command/key-file config, and
  remote credential scrubbing.
- Added `firsttrace doctor repos --config firsttrace.config.yaml` for repository
  owner-evidence readiness diagnostics.
- Added passive repository readiness to `/healthz` for mounted or already
  materialized repos.
- Tightened deterministic owner evidence collection around exact-line Git blame,
  follow-history Git log context, author/committer metadata, commit timestamps,
  snippets, and at most two person candidates.
- Manager-owner triage now uses normalized evidence source names and renders a
  non-assignment action when person-level owner evidence is missing.
- AI grounding continues to remove owner candidates that are absent from
  structured owner evidence.
- OCI package builds now have an explicit
  `FIRSTTRACE_INCLUDE_REPO_GIT_HISTORY=true` opt-in for preserving nested
  configured repository `.git` history.
- README and OCI deployment docs document generic Git repos, `doctor repos`,
  `/healthz` repo readiness, missing owner evidence behavior, read-only
  credentials, and package-history opt-in.
- Published `firsttrace@0.1.6` to npm with the `latest` dist-tag.

## Not Implemented In 0.1.6

- No GitLab, Bitbucket, Azure DevOps, or OCI DevOps provider adapter was added.
  Use generic `provider: git` for those hosts unless a provider adapter is
  needed later for host-specific PR/pusher metadata.
- No write actions were added: FirstTrace still does not create tickets, edit
  code, mutate repositories, or assign team ownership when person evidence is
  missing.
- Automatic CODEOWNERS parsing and work-item provider integrations remain future
  work.
