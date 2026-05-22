# FirstTrace Implementation Guide

This file is the durable handoff for future implementation sessions. Keep it
generic: every external system is a provider or adapter, not a core dependency.

## Product Context

FirstTrace is a self-hosted bug localization tool for teams with private,
internal, or public git repositories. It accepts a bug report, gathers local
evidence from configured repos/docs/issues/owners, optionally asks an AI provider
to reason over that bounded evidence, and returns a cited first investigation.

The core product should stay read-only until the triage quality is trusted. Do
not add ticket creation, code editing, or system mutations to the core
investigation path.

## Current Stack

- TypeScript on Node.js
- npm scripts
- `tsx` for local CLI execution
- `typescript` for typechecking
- `vitest` for tests
- `yaml` for config parsing
- `openai` for the first AI provider
- `zod` for structured AI output validation
- `dotenv` for local `.env.local` development credentials

Current command:

```bash
npm run firsttrace -- investigate \
  --config firsttrace.config.yaml \
  --report "README deployment plan is unclear"
```

AI-assisted command:

```bash
npm run firsttrace -- investigate \
  --config firsttrace.config.yaml \
  --report "README deployment plan is unclear" \
  --ai
```

## Provider Architecture

The investigation engine should only depend on generic interfaces. Provider
implementations can use vendor SDKs, MCP tools, REST APIs, CLIs, local files, or
host services internally.

Provider categories:

- `GitProvider`: local git now; GitHub, GitLab, Bitbucket, internal git later.
- `OwnershipProvider`: YAML/globs now; CODEOWNERS and org ownership graph later.
- `IssueProvider`: issue exports now; GitHub Issues, Jira, OCI, Linear later.
- `AiProvider`: OpenAI now; Claude, Google AI, local model providers later.
- `ChatProvider`: CLI now; Slack first later; Teams, Discord, email, API later.
- `QueueProvider`: in-memory/filesystem first; Redis, Supabase, OCI Queue later.
- `RuntimeProvider`: local process now; Docker, Vercel/Supabase, OCI, Kubernetes later.
- `OutputAdapter`: Markdown CLI now; chat replies, JSON API, dashboard later.

Rules:

- Core code receives normalized requests and returns normalized results.
- Core code should not import Slack, OpenAI, GitHub, Vercel, Supabase, or OCI SDKs.
- Vendor SDK imports belong inside provider implementation files.
- Evidence collection stays deterministic before AI reasoning.
- AI providers reason over bounded evidence bundles and citations, not blind repo
  access.
- New providers must be additive. Avoid changing result shape only because one
  vendor has different terminology.

## Phase Order

Completed:

1. Phase 1: deterministic local CLI.
2. Phase 2: optional OpenAI AI provider for local CLI.
3. Phase 3: eval runner.
4. Phase 4: local worker runtime.

Next:

1. Phase 5: local message delivery adapter.
   - Add `submit` CLI command or local HTTP endpoint.
   - Submit a report to the worker and fetch/store the result.
2. Later: Slack as the first chat provider.
   - Preserve a generic `ChatProvider` boundary so Teams or other systems can
     use the same worker and investigation core.
3. Later: provider expansion.
   - GitHub provider for repo/issues.
   - Vercel/Supabase runtime or queue provider for dogfood deployment.
   - OCI runtime/queue/work-item provider for enterprise deployment.

Worker runtime details:

- The Phase 4 queue provider is filesystem-backed and stores jobs under
  `.firsttrace/jobs`.
- `.firsttrace/` is ignored and must not be committed.
- Worker commands are low-level local runtime commands, not the Phase 5
  user-facing message delivery adapter.
- Worker execution must keep using the shared investigation path so CLI, eval,
  and worker behavior stay consistent.
- Future Redis, Supabase, Vercel, and OCI queues should implement the same queue
  provider boundary instead of changing investigation logic.

Eval runner details:

- Public eval files live under `evals/` and must stay generic.
- Private/customer eval files should stay outside the public repo.
- Eval scoring must stay provider-neutral.
- AI eval comparison is opt-in with `--ai` and reuses the same AI provider path
  as `investigate --ai`.

## Testing Expectations

Every phase should include:

- `npm run typecheck`
- `npm test`
- focused CLI smoke tests for the changed command
- `git diff --check`
- secret safety checks when credentials or providers are touched

For AI-related changes:

- deterministic CLI behavior without `--ai` must remain unchanged
- missing credentials must fail clearly
- AI output must be schema-validated
- AI claims must be grounded in FirstTrace evidence citations
- tests should not require live API calls, but at least one manual/local smoke
  can use `.env.local` when the user explicitly wants live validation

## Security Defaults

- Do not commit `.env.local`, secrets, tokens, API keys, or private repo data.
- Keep `.env.example` empty or filled only with safe placeholders.
- Prefer read-only provider scopes.
- Make external API calls explicit and configurable.
- Keep LLM input bundles inspectable and bounded.
- Do not log full source files or secrets by default.
