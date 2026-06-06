# FirstTrace Product Plan

FirstTrace is a self-hosted manager-owner bug triage tool for teams with
private, internal, or public git repositories. It turns a messy bug report from
chat, CLI, or another source into a cited PM/manager-facing handoff: the
user-facing issue, one or two evidence-backed owner candidates, likely root
cause, user impact, and recommended manager action.

This document is the working blueprint. The README explains the project at a
high level; this plan describes what to build and in what order.

## Current Validation Status

- `firsttrace@0.1.5` is published on npm and is the preferred reusable install
  artifact for new deployments.
- The OCI backend has passed a clean npm-install acceptance flow: a fresh
  operations directory installed the package, copied the packaged Terraform and
  deployment files, provisioned a new OCI stack, synced runtime secrets into OCI
  Vault, deployed an npm-based container image, and ran live Slack acceptance.
- OCI live acceptance currently verifies health/build metadata, real Slack event
  delivery, exactly one processing reply, exactly one final reply, duplicate
  Slack event dedupe, worker completion, and OCI Queue redelivery.
- The Vercel/Supabase backend remains supported through an npm-wrapper Vercel
  template plus Supabase migrations. Its reusable live acceptance command exists;
  a fresh production acceptance run is the next validation step.

## Product Thesis

PMs and managers are the first target audience. They need to understand whether
a report is likely a product bug, who the strongest person-level owner
candidates are, what evidence points to those people, what likely went wrong,
how users are affected, and what assignment or follow-up action is warranted.

Engineers can use Codex or other AI/code tools later to debug and implement the
fix. FirstTrace should not try to be the engineer's full debugging workspace.
It should automate the evidence gathering and manager handoff that happens
before an engineer starts changing code.

The product wins when it gives a concise, cited triage answer faster than a
human triager could assemble one manually, while refusing to assign a person
when person-level evidence is missing.

## Design Principles

- **Manager-readable by default:** the primary response should be understandable
  to PMs and engineering managers, not only to the engineer who will debug the
  code later.
- **Evidence first:** every important claim should link back to a file, commit,
  owner rule, issue, or source message.
- **Person ownership requires person evidence:** do not turn team aliases,
  broad file ownership, or weak recency into a person assignment.
- **Read-only by default:** v0 should not write code, create tickets, or mutate
  customer systems.
- **Self-hostable:** teams should be able to run it near their private repos and
  internal systems.
- **Runtime-portable:** Slack, Jira, GitHub, Supabase, Redis, OCI, and Vercel are
  adapters, not core assumptions.
- **Multiple hosted backends now:** the project currently supports a
  Vercel/Supabase hosted path and an OCI hosted path, while keeping the local
  filesystem runtime for development and evals.
- **Eval before integrations:** the core investigation engine should prove it
  can find useful files and owners before Slack or other chat integrations.
- **Small trusted output:** a concise, grounded reply is better than a long,
  speculative report.
- **Generic upstream behavior:** route, owner, provider, and workflow heuristics
  must be reusable and must not hard-code one company's routes, repositories,
  domain nouns, tenants, or chat channels.

## Non-Goals

FirstTrace v0 is not:

- an autonomous code-writing or code-fixing agent
- a ticket-writing or ticket-routing system
- a generic workplace search product
- a replacement for on-call engineers or code-level debugging tools
- an engineer-first debug chat bot as its primary product surface
- a SaaS-only product
- a tool that needs write access to source code
- a workflow engine like Temporal

Fix suggestions, ticket creation, dashboards, scheduled indexing, and enterprise
admin features can come later.

## Architecture

```mermaid
flowchart TD
  Source["Input Source<br/>CLI, Slack, Teams, API"] --> ChatProvider["Chat/Input Provider"]
  ChatProvider --> Request["Investigation Request"]
  Request --> Engine["Investigation Engine"]

  Engine --> Git["Git Provider<br/>local repo, internal git, GitHub"]
  Engine --> Owners["Ownership Provider<br/>CODEOWNERS, firsttrace.owners.yaml"]
  Engine --> Issues["Issue Provider<br/>Jira, GitHub Issues, fixtures"]
  Engine --> Reasoner["Investigator Provider<br/>FirstTrace agent, codex-cli"]
  Engine --> Runtime["Runtime Provider<br/>local, Vercel, Supabase, OCI"]

  Git --> Evidence["Evidence Store"]
  Owners --> Evidence
  Issues --> Evidence
  Reasoner --> Result["Investigation Result"]
  Evidence --> Result

  Result --> Output["Output Adapter<br/>CLI, Slack reply, markdown, API"]
```

The core investigation engine should not know whether the request came from
Slack or a CLI command. It should receive structured input, collect evidence,
rank the evidence, and return a structured result with citations.

## Core Data Model

```text
InvestigationRequest
  id
  source
  reportText
  threadContext
  repositories
  issueProjects
  createdAt

EvidenceItem
  id
  type: file | commit | diff | owner | issue | message
  title
  summary
  citation
  score
  metadata

InvestigationResult
  requestId
  classification: bug | feature_request | support_question | unknown
  likelyComponent
  confidence
  suspiciousFiles
  likelyOwners
  relatedIssues
  suggestedNextSteps
  citations
  warnings

ManagerOwnerTriageResult
  title
  issue
  likelyOwnerCandidates[0..2]
    rank
    name
    email
    confidence: High | Medium | Low
    reason
    evidenceSource: exact_line_blame | introduced_pattern |
      related_file_history | provider_pr_author | provider_pushed_by |
      commit_author | committer | unknown
    evidenceCommits[]
      commitId
      commitTime
      commitTitle
      repo
      file
      line
      evidenceCode
      whyRelevant
  likelyRootCause
  userImpact
  recommendedManagerAction
  missingInfo[]

TriageQuality
  executionStatus: succeeded | failed
  triageQuality: strong | medium | weak | failed
  foundExactFile
  foundExactLine
  foundPersonOwner
  foundCommitEvidence
  usedTeamFallback
  evidenceWarnings[]

WorkItemDraft
  title
  description
  owner
  areaPath
  tags
  severity
  priority
  sourceCitations

ChannelProfile
  goals
  ownershipRules
  responsePreferences
  enabledProviders

EvalCase
  id
  report
  repo
  expectedClassification
  expectedComponent
  expectedFiles
  expectedOwners
  expectedWorkItem
  notes
```

The first implementation can keep these as TypeScript types or plain JSON
schemas. For the next version, `ManagerOwnerTriageResult` becomes the external
default response contract for bug reports, while the existing engineering
investigation fields remain available internally and for diagnostics.

The important boundary is that providers return evidence, and the investigator
reasons over that evidence with read-only tools instead of inventing facts.
Names, emails, commits, timestamps, file paths, lines, and snippets must come
from Git/provider metadata or explicit owner maps.

## Provider Interfaces

FirstTrace should be built around small provider interfaces:

```text
GitProvider
  listFiles()
  searchFiles(query)
  searchCommits(query)
  getFile(path)
  getDiff(commit)

OwnershipProvider
  getOwnersForPath(path)
  searchOwnership(query)

OwnerEvidenceProvider
  collectLineBlame(repo, path, line)
  collectFileHistory(repo, path)
  collectCommitMetadata(repo, commit)
  rankOwnerCandidates(evidence)

ProviderMetadataAdapter
  getCommitMetadata(commit)
  getPullRequestMetadata(commit)
  getPushedByMetadata(commit)

IssueProvider
  searchIssues(query)
  getIssue(id)

InvestigatorProvider
  investigate(request, evidence, tools)
  returnStructuredResult()

InvestigationToolset
  readFile(path)
  searchRepo(query)
  findReferences(symbolOrPath)
  gitLog(path)
  gitBlame(path, line)
  runSafeCommand(command)

AiProvider
  structuredCompletion(prompt, schema)

InputProvider
  receive()
  normalize()

OutputAdapter
  render(result)
  send(result)

RuntimeProvider
  enqueue(job)
  runWorker()
  persistResult(result)
```

Phase 1 providers are deliberately simple:

- local git provider using the checked-out repository
- ownership YAML provider using `firsttrace.config.yaml`
- CLI/markdown output adapter

Future phases add:

- read-only FirstTrace agent provider first, powered by a pluggable model
  provider and `FIRSTTRACE_MODEL_CHAT`
- later `codex-cli` investigator adapter using the same model and the same
  structured result contract
- fixture issue provider for evals
- Slack chat provider first, with Teams or other chat providers possible later
- GitHub issue/code provider, Vercel/Supabase runtime providers, and OCI
  deployment/runtime providers as adapters

Provider implementations can depend on a vendor SDK, but the core investigation
engine should only depend on the provider interfaces. Adding Slack, OpenAI,
GitHub, Vercel, Supabase, OCI, `codex-cli`, Teams, or another service should not
require rewriting the core search, evidence, investigation, evaluation, or
rendering flow.

## Channel Agent Model

FirstTrace should support a generic channel-agent model without tying the core
product to any one chat platform or company workflow.

```text
ChannelProfile
  goals
  expected work types
  ownership and SME routing rules
  response preferences
  enabled apps and providers

SkillDefinition
  triage feedback
  log a bug or work item
  link related work items
  search existing work

Trigger
  manual CLI command
  at-mention
  emoji reaction
  top-level channel message
  API request
```

In this model, automatic triage can run on broad triggers, but write actions
such as creating a bug should require a deliberate trigger or an explicit policy
in the channel profile.

## Version 0.1.6: Git History And Owner Evidence - Implemented

The customer-requested 0.1.6 owner-evidence work is implemented on the
`0-1-6-release` branch. It fits the open-source direction because it is generic,
provider-neutral, read-only, and useful to any team that wants manager-facing
bug-owner triage from private, internal, or public Git repositories without
forking FirstTrace or patching deployed code.

Implemented 0.1.6 scope:

- FirstTrace is explicitly PM/manager-first in README, package description, and
  product positioning. Engineers receive cited evidence for later debug/fix
  work, but the product surface is a manager-owner triage handoff.
- Repository config supports `provider: local`, `provider: archive`,
  `provider: git`, and the existing `provider: github` adapter.
- Generic `provider: git` repos support read-only clone/fetch, branch/tag/SHA
  refs, full clone by default, explicit shallow clone warnings, HTTPS token
  credentials from env vars, SSH command/key-file config, and credential
  scrubbing after materialization.
- `firsttrace doctor repos --config firsttrace.config.yaml` actively
  materializes and validates configured repositories, then prints JSON readiness
  with Git history availability, shallow status, head SHA, ref, refresh status,
  owner evidence readiness, missing metadata, and evidence source names.
- `/healthz` now includes passive repository readiness for already-mounted or
  already-materialized repositories without cloning/fetching on every health
  request.
- Deterministic owner evidence collects exact-line `git blame --line-porcelain`,
  follow-history `git log --follow` context, full commit SHA/title, author and
  committer identities, author timestamp, commit timestamp, file, line, snippet,
  evidence source, and relevance reason before any model call.
- Owner candidates are grouped by person, capped at two, and require
  person-level evidence. Archive/source-only repos without `.git` history return
  no invented owner and list missing metadata.
- The manager-owner triage schema uses the normalized evidence source values
  `exact_line_blame`, `introduced_pattern`, `related_file_history`,
  `provider_pr_author`, `provider_pushed_by`, `commit_author`, `committer`, and
  `unknown`.
- The Markdown renderer always uses the manager-owner sections. When no
  person-level owner exists, it renders an explicit non-assignment manager action
  instead of routing to a weak team or invented person.
- AI grounding keeps the model from adding owner candidates absent from
  structured owner evidence.
- OCI package builds can opt into preserving nested configured repo `.git`
  directories with `FIRSTTRACE_INCLUDE_REPO_GIT_HISTORY=true`, while root
  FirstTrace `.git` remains excluded and the default packaged-snapshot behavior
  stays source-only.
- README and OCI deployment docs describe `provider: git`, archive/local
  behavior, `doctor repos`, `/healthz` repo readiness, missing owner evidence,
  read-only credentials, and packaged `.git` history opt-in.
- `0-1-6-release-notes.md` tracks the implemented changes and release
  boundaries for this branch.

Release boundary:

- Do not publish the npm 0.1.6 package until the release process is run
  separately.
- GitLab, Bitbucket, Azure DevOps, OCI DevOps, Jira/issue metadata, automatic
  CODEOWNERS parsing, and write-capable work-item creation remain future work.
- Historical customer-specific eval cases should stay private/downstream; public
  evals should remain generic.

## Phased Roadmap

### Phase 1: Deterministic Local CLI - Complete

The implemented Phase 1 flow is:

```bash
firsttrace investigate \
  --config firsttrace.config.yaml \
  --report "README deployment plan is unclear"
```

Current capability:

- read a YAML config with explicit repositories, docs, issue exports, owners,
  and search limits
- classify the report as bug, feature request, support question, or unknown
- search local files, configured docs, configured issue exports, and recent git
  commits
- resolve owners from path/glob rules
- rank deterministic evidence and print Markdown with citations

Limitations:

- no OpenAI reasoning
- no eval runner
- no worker
- no message delivery adapter
- no Slack, Docker, or npm publishing

### Phase 2: OpenAI Reasoner for Local CLI - Complete

The implemented Phase 2 flow adds an optional AI reasoning pass on top of Phase
1 evidence:

```bash
firsttrace investigate \
  --config firsttrace.config.yaml \
  --report "checkout retry leaves the buyer stuck" \
  --ai
```

The CLI continues to gather deterministic evidence first. OpenAI reasons over
that bounded evidence bundle, not the repository directly.

Current capability:

- opt-in `--ai` flag for local CLI investigations
- provider interface for the current one-shot AI reasoning path
- OpenAI provider using structured output
- `.env.local` support for local credentials
- AI result section with likely files/components, confidence, owner and
  implementer hints, explanation, missing-information questions, warnings, and
  citations

Local configuration:

- `FIRSTTRACE_AI_PROVIDER=openai|oci-genai`; `openai` uses direct OpenAI API
  credentials, while `oci-genai` uses OCI Generative AI with OCI auth
- `FIRSTTRACE_MODEL_CHAT` from `.env.local` or the shell as the provider-neutral
  model selector
- `OPENAI_API_KEY` only when `FIRSTTRACE_AI_PROVIDER=openai`
- `OPENAI_MODEL_CHAT` remains as a legacy OpenAI-specific alias
- `FIRSTTRACE_INVESTIGATOR=agent|evidence|codex-cli`, with `agent` as the
  default when `--ai` is enabled
- explicit opt-in through `--ai`

Planned model direction:

- keep `FIRSTTRACE_MODEL_CHAT` as the shared model selector for `agent`,
  `evidence`, and later `codex-cli`
- keep `OPENAI_MODEL_CHAT=gpt-5.4-mini` as a compatibility default for direct
  OpenAI runs
- use OCI GenAI models such as `openai.gpt-oss-120b` for OCI-hosted deployments
  where direct OpenAI API use is not allowed
- avoid cross-model benchmarking for now; compare investigation modes, not model
  families

Limitations:

- no eval runner
- no worker
- no message delivery adapter
- no Slack, Teams, Docker, npm publishing, or work-item creation

### Phase 3: Eval Runner - Complete

The implemented Phase 3 flow adds eval cases before chat or worker integrations:

```bash
firsttrace eval \
  --config firsttrace.config.yaml \
  --cases evals/example.yaml
```

Optional AI comparison:

```bash
firsttrace eval \
  --config firsttrace.config.yaml \
  --cases evals/example.yaml \
  --ai
```

Current capability:

- load YAML eval case arrays
- run deterministic investigations for every case
- optionally run the configured AI provider on the same deterministic evidence
- score classification accuracy, expected files, expected owners, expected
  component, citation coverage, unsupported AI citation warnings, and aggregate
  usefulness
- print a Markdown eval summary and per-case pass/fail detail
- exit nonzero when a required expectation fails or the cases file is invalid

Private or customer-specific eval cases should stay outside the public
repository.

Limitations:

- no worker
- no message delivery adapter
- no Slack, Teams, Docker, npm publishing, or work-item creation

### Phase 4: Local Worker Runtime - Complete

The implemented Phase 4 flow adds a local asynchronous runtime that reuses the
same investigation engine as the CLI:

```bash
firsttrace worker enqueue \
  --config firsttrace.config.yaml \
  --report "README deployment plan is unclear"

firsttrace worker run --once

firsttrace worker status --job <job-id>
```

Current capability:

- filesystem-backed queue under `.firsttrace/jobs`
- generic `JobQueue` interface with a filesystem provider
- one JSON file per investigation job
- queued, running, succeeded, and failed job states
- persisted timestamps, attempts, config path, report, AI flag, result, and
  error details
- deterministic worker processing using the shared investigation path
- optional AI worker processing using the same AI provider path as
  `investigate --ai`

Limitations:

- no Slack, Teams, Docker, npm publishing, Redis, Supabase, OCI, or work-item
  creation

### Phase 5: Message Input Adapter - Complete

The implemented Phase 5 flow adds a local message delivery adapter before Slack:

```bash
firsttrace submit \
  --config firsttrace.config.yaml \
  --report "checkout retry leaves the buyer stuck"
```

Current capability:

- `submit` validates local message input
- creates a queued investigation job through the generic queue interface
- records source metadata such as `local-cli`
- prints the worker command and status command needed to process or fetch the
  result
- supports optional AI reasoning with `--ai`
- keeps the path compatible with future chat adapters

Limitations:

- no local HTTP endpoint
- no Slack, Teams, hosted receiver, or webhook handling

### Phase 6: Hosted Vercel/Supabase Runtime - Complete

The implemented Phase 6 flow adds a hosted backend path for teams that want
FirstTrace to run as a dedicated service:

```text
npm wrapper on Vercel -> Supabase Queue/Database -> Worker Process -> Result Store
```

Current capability:

- async `JobQueue` boundary shared by filesystem and Supabase queues
- Supabase-backed job storage in `firsttrace_jobs`
- atomic Supabase job claiming through `firsttrace_claim_next_job()`
- queue selection with `--queue filesystem|supabase` or
  `FIRSTTRACE_QUEUE_PROVIDER`
- provider-neutral Vercel-compatible endpoints:
  - `POST /api/investigations`
  - `GET /api/jobs?id=<job-id>`
  - `GET|POST /api/worker/run-once`
- package exports for ready-made Vercel handlers and a packaged
  `deploy/vercel` wrapper template
- Vercel Terraform template for project/runtime environment setup
- package-provided Supabase migrations applied with the Supabase CLI
- required bearer auth through `FIRSTTRACE_RECEIVER_TOKEN`, unless
  `FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER=true` is explicitly set for local
  development
- worker reuse of the same investigation engine as the local CLI
- Vercel background worker execution from Slack events plus a protected
  `run-once` endpoint for manual runs or cron-capable deployments

Vercel and Supabase should be adapters, not assumptions in the core
investigation logic. The OCI deployment path now reuses the same core worker;
future Docker, Kubernetes, Redis, or Postgres deployments should follow the same
adapter boundary.

Limitations:

- no Teams or non-Slack webhook provider
- worker execution is one-job-at-a-time and should be hardened before larger
  customer traffic
- local readiness can pass while optional live checks remain blocked

### Phase 7: GitHub Provider for Private/Public Repositories - Complete

The implemented Phase 7 flow adds a GitHub App-backed repository provider so
hosted FirstTrace can inspect configured GitHub repositories without relying on
a pre-existing local checkout:

```text
GitHub App -> GitHub Provider -> Evidence Collector
```

Current capability:

- local `path` repository configs remain valid and default to `provider: local`
- `provider: github` repository configs support owner, repo, and default branch
- `provider: archive` repository configs support a generic `archive_command`
  for internal git/archive systems that can materialize a local working tree
- GitHub App credentials are read from environment secrets
- local validation can use `GITHUB_TOKEN` when a user-scoped token already has read
  access to the target repository
- escaped private-key newlines are normalized for hosted env stores
- short-lived installation tokens are created at runtime
- clone/fetch uses `git -c http.extraHeader="Authorization: Basic <redacted>"`
  so tokens are not stored in remote URLs or git config
- GitHub repos are cached under ignored `.firsttrace/github/`
- after materialization, the existing file search, doc search, commit search,
  owner matching, AI reasoning, eval, worker, and queue flows run unchanged

Required environment variables:

```text
GITHUB_APP_ID
GITHUB_APP_INSTALLATION_ID
GITHUB_APP_PRIVATE_KEY
```

Local-only fallback:

```text
GITHUB_TOKEN
```

Limitations:

- no Slack, Teams, or webhook provider
- no GitHub Issues or pull request evidence provider
- no ticket creation or repository write access
- live private-repo testing requires a user-created GitHub App and local ignored
  config

Local git should remain a first-class provider. GitHub is the first hosted git
provider, not the only git provider.

### Phase 8: Slack Chat Provider and Channel Config - Complete

The implemented Phase 8 flow adds Slack as the first chat adapter while keeping
the core product generic:

```text
Slack message -> Receiver -> Queue -> Worker -> Slack thread reply
```

Current capability:

- verify incoming requests
- handle Slack URL verification challenges
- acknowledge events quickly after enqueueing or ignoring them
- dedupe Slack retries by team, trigger, channel, source message timestamp, and
  reaction name when applicable
- restrict automatic handling to configured Slack channel ids
- support configured triggers for top-level messages, app mentions, and emoji
  reactions
- fetch reacted message text before enqueueing reaction-triggered jobs
- fetch thread message text for app mentions in threads when a Slack client is
  configured
- enqueue normalized investigation jobs through the generic `JobQueue`
- post concise cited worker results back to Slack threads when `SLACK_BOT_TOKEN`
  is configured
- keep channel names, channel ids, trigger behavior, AI opt-in, and repo routing
  in config
- validate a minimal Slack app manifest profile so new installs can start with
  only `app_mentions:read`, `chat:write`, and the `app_mention` event
- run `firsttrace doctor` to validate config loading, local repository paths,
  Slack receiver/reply env, GitHub materialization credentials, and AI provider
  availability before deployment

Required environment variables for hosted Slack:

```text
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
```

Default Slack setup should be mention-only. Top-level message and reaction
triggers stay independently configurable, but enabling them should be an
explicit product decision because they require broader Slack history or reaction
read scopes.
Slack app mentions send only the explicit mention text by default; full thread
context requires `include_thread_context: true`. Channel data classification is
part of config, and `restricted` channels skip AI even when both AI gates are on.
Before any model call, the AI safety layer redacts common credentials and skips
AI for PHI, PCI, legal/dispute, and customer production-data markers. A dry-run
mode can show the sanitized report path without calling the configured model.
Hosted Slack deployments should use a public HTTPS Events request URL with
Socket Mode off by default. Enterprise installs may need a generic backend
service-registration step before Slack is connected; FirstTrace docs should list
the usual app name, owner, public URL, event URL, data classification, and auth
metadata without making organization-specific assumptions.
The OCI package image always creates `/app/repos`, and the build script can copy
`FIRSTTRACE_REPOS_DIR` there for local snapshot deployments while still allowing
GitHub/archive-only images to build with an empty placeholder.

Limitations:

- no Slack command shortcut or modal flow
- message and reaction triggers are explicit opt-ins because they require
  broader Slack event subscriptions than the default app-mention path
- channel repository routing is parsed and preserved, but repository subset
  filtering is deferred until multi-repo hosted deployment needs it
- Vercel/Supabase now has a reusable live Slack acceptance command; OCI has
  passed the live Slack path through `hosted accept`

The investigation engine should remain chat-agnostic so Teams, Discord, Linear,
or other sources can be added later.

### Phase 9A: Hosted Deployment Readiness Runner - Complete

The implemented Phase 9A flow proves the hosted orchestration path locally
without pretending live external services have passed:

```bash
firsttrace hosted verify \
  --config examples/hosted.local.config.yaml \
  --queue filesystem \
  --report "README deployment plan is unclear"
```

Current capability:

- creates a synthetic signed Slack event and sends it through the Slack Events
  receiver
- enqueues through the selected queue provider
- runs the existing worker once against that queue
- uses a fake Slack notifier by default so local verification does not post to
  Slack
- supports `--queue filesystem|supabase`, `--ai`, `--channel <id>`, and
  `--live-slack-post`
- renders a Markdown pass/fail report with job status, result component, owners,
  captured Slack reply summary, and external readiness checks
- keeps external checks separated by backend so local readiness can pass without
  implying that every live deployment target has passed acceptance

Limitations:

- local readiness can pass while optional live checks remain blocked
- `hosted verify` is a local readiness command; deployed backends should use
  `hosted accept`
- live Vercel/Supabase processing still needs a fresh acceptance run against a
  deployed npm-wrapper project with all FirstTrace migrations applied

### Phase 9B: Live Hosted Verification - OCI Complete, Vercel/Supabase Harness Ready

Prove the full hosted workflow for a generic company setup:

```text
configured Slack channel
  -> selected HTTPS receiver
  -> selected queue backend
  -> worker
  -> GitHub private repo evidence
  -> configured investigator
  -> Slack thread reply
```

This phase is complete for the OCI backend through `firsttrace hosted accept`.
The Vercel/Supabase backend now has the same acceptance shape through
`firsttrace hosted accept --backend vercel-supabase`; the remaining work is to
run it against a fresh npm-wrapper Vercel deployment. Each backend should verify:

- a configured Slack channel can submit a bug report without CLI access
- an unconfigured channel is ignored or receives a safe denial
- the backend validates Slack signatures before enqueueing work
- the worker can read a private GitHub repository through the configured provider
- the configured investigator uses gathered evidence and citations
- the Slack reply names classification, likely owner, primary files, likely
  cause, next checks, confidence, and compact evidence
- no company-specific names, repositories, or channels are hardcoded

### Phase 9C: OCI Queue Runtime - Implemented

Add an Oracle Cloud Infrastructure deployment path without removing or
weakening the existing Vercel/Supabase path. The goal is side-by-side production validation:
one Slack app or channel can keep using Vercel/Supabase while another can use
OCI, or a later router can select the runtime per channel/prefix.

FirstTrace therefore currently has two hosted backend families:

- Vercel/Supabase for teams that prefer the Vercel function plus Supabase queue
  model.
- OCI for teams that prefer OCI Queue, Container Instances, Object Storage,
  Vault/KMS, OCIR, and API Gateway.

Preferred OCI shape for the first implementation:

```text
Slack Event
  -> OCI HTTPS receiver
  -> OCI Queue message
  -> OCI worker container
  -> OCI Object Storage dedupe/processing marker
  -> GitHub repo materialization
  -> configured investigator
  -> Slack thread processing message + final reply
```

Deliberate scope:

- keep Vercel/Supabase adapters and production deployment intact
- add OCI as a new runtime adapter, not a replacement
- use OCI Queue as the work queue from the start
- avoid Autonomous Database in the first OCI deployment unless the need for a
  queryable dashboard or long-term job history becomes real
- treat Slack as the long-term human-readable history
- use OCI Object Storage only for small runtime markers:
  - Slack event dedupe key
  - processing message timestamp
  - final status marker for retry safety
- keep queue messages small enough for OCI Queue limits by storing only report,
  Slack source, config/runtime hints, and correlation ids

Why Queue plus Object Storage marker instead of a database:

- OCI Queue is the correct primitive for work delivery, visibility timeout,
  retries, and dead-letter handling
- FirstTrace does not need queryable job history for OCI deployment if Slack keeps
  the visible history
- Object Storage markers are enough to avoid duplicate replies when Slack
  retries events or OCI Queue redelivers work
- this keeps the OCI MVP smaller than adding Autonomous Database, schema
  migrations, SQL claim logic, and DB credentials

Implemented FirstTrace code changes:

- package-based OCI image that installs `firsttrace@<version>` from npm and
  includes Node, git, and ripgrep so hosted investigations have the same search
  tools locally and in production
- generic long-running HTTP server for non-Vercel runtimes:
  - `POST /api/slack/events`
  - `POST /api/investigations`
  - `GET /api/jobs?id=<id>` can be omitted or return queue-marker status only
  - `GET|POST /api/worker/run-once` for manual repair/debug
- `OciQueue` adapter for OCI Queue publish/consume/delete/update
- Object Storage runtime state backed by Object Storage for dedupe and processing
  markers
- Slack notifier support for:
  - posting a short "processing" reply immediately after enqueue/claim
  - storing that processing message timestamp in the marker
  - posting the final investigation reply in the same thread
  - skipping duplicate final replies when a marker already says completed
- config/runtime selection:
  - `FIRSTTRACE_QUEUE_PROVIDER=oci`
  - OCI compartment/queue/object-storage env vars
  - no company-specific Slack channel names or repo names in core code
- Terraform-first deployment under `deploy/oci` for OCI Resource Manager or
  local Terraform
- Vault sync helper that can prompt interactively, read shell environment
  secrets, or opt into an explicit env file without storing secret values in
  Terraform state

OCI resources:

- OCI Queue for job delivery
- OCI Container Registry for the FirstTrace image
- OCI Container Instances or a small Compute VM for receiver/worker containers
- OCI Object Storage bucket for dedupe/processing/final markers
- OCI Vault for Slack, GitHub, receiver, and optional direct-OpenAI secrets
- OCI API Gateway for a public HTTPS Slack Events URL

OCI account plan:

- create a new OCI account and choose the home region carefully
- create or choose a `firsttrace` compartment
- set budget alerts before deploying anything
- use the Oracle Cloud Free Trial credits for Queue, Container Registry,
  Container Instances/API Gateway/Load Balancer experiments
- keep Always Free-compatible resources where possible, but do not assume OCI
  Queue is Always Free; verify pricing before leaving it running

Production validation plan:

Completed for the current OCI path:

1. Deploy OCI receiver and worker container with `FIRSTTRACE_QUEUE_PROVIDER=oci`.
2. Point the configured Slack app Event Subscription request URL to the OCI URL.
3. Run `firsttrace hosted accept --backend oci` against the API Gateway base URL.
4. Require the health endpoint to report OCI as the queue provider and a
   `FIRSTTRACE_BUILD_REF` based on the published npm package.
5. Confirm the harness posts a Slack seed message, sends the same signed Slack
   event twice, observes one processing reply and one final reply, and sees the
   job reach `succeeded`.
6. Confirm the acceptance-only temporary OCI Queue redelivery probe can claim,
   abandon, reclaim, and delete a message without interrupting the real worker.

Still useful to repeat before releases:

1. Rebuild the package image from the current published npm version.
2. Rerun `firsttrace hosted accept --backend oci` against the deployed API
   Gateway URL.
3. Compare investigation quality and latency against the Vercel/Supabase path
   once that path has its own live acceptance result.

### Phase 10: Read-Only Agentic Investigator

Improve investigation quality by turning the current one-shot evidence summary
into a small read-only evidence agent that supports the manager triage response:

```text
Slack report
  -> retrieve candidate files and commits
  -> FirstTrace agent
  -> read files, follow imports/usages, inspect git history/blame
  -> optionally run safe allowlisted commands
  -> return cited structured JSON
  -> manager-owner triage handoff
```

The current deterministic search should remain useful as the first candidate
generator and as the fallback path. The new agent should iterate over those
candidates with explicit read-only tools instead of asking the model to summarize
one fixed evidence bundle.

Target behavior:

- use `FIRSTTRACE_MODEL_CHAT` for production validation across model providers
- do not add a separate model env var for agent mode
- support `FIRSTTRACE_AI_PROVIDER=oci-genai` for OCI deployments where direct
  OpenAI API use is not allowed
- add an investigator mode such as `FIRSTTRACE_INVESTIGATOR=agent`
- keep the existing evidence mode available as a fallback, for example
  `FIRSTTRACE_INVESTIGATOR=evidence`
- expose only bounded tools: `readFile`, `searchRepo`, `findReferences`,
  `gitLog`, `gitBlame`, and allowlisted `runSafeCommand`
- enforce max steps, max runtime, max file bytes, and command allowlists
- require structured JSON with cited files, lines, commits, authors, confidence,
  user impact, manager action, missing information, and warnings
- make the agent usable from CLI, local worker, and Supabase-backed worker
  without requiring Docker
- test quality with eval cases and live Slack reports

Non-goals for this phase:

- no code edits or write actions
- no arbitrary shell access
- no dependency on `codex-cli`
- no benchmark against `gpt-5.3-codex`

### Phase 10B: OCI GenAI Model Provider

Add OCI Generative AI as a first-class model provider for teams that cannot send
repository evidence to the direct OpenAI API.

Target behavior:

- `FIRSTTRACE_AI_PROVIDER=oci-genai` works for both `FIRSTTRACE_INVESTIGATOR=agent`
  and `FIRSTTRACE_INVESTIGATOR=evidence`
- OCI deployments use OCI IAM/resource-principal authentication through the OCI
  SDK, not `OPENAI_API_KEY`
- `FIRSTTRACE_MODEL_CHAT` selects the model for all providers; OCI deployments
  can use an approved OCI model such as `openai.gpt-oss-120b` or a dedicated
  endpoint model
- `OCI_GENAI_REGION` can target a subscribed OCI GenAI model region separately
  from the runtime `OCI_REGION`, so Queue/Object Storage/Vault can stay local
  while inference runs where the approved model is available
- Slack-originated AI is double gated: the channel config must set
  `ai_enabled: true` and the hosted runtime must set `FIRSTTRACE_AI_ENABLED=true`
- Terraform passes provider/model runtime config directly and keeps only real
  secrets in OCI Vault
- the OCI runtime dynamic group has permission to call OCI Generative AI in the
  configured compartment
- OCI Vault loading is explicit: production can fail closed on missing secrets,
  while bootstrap/UAT can set `OCI_VAULT_SECRETS_REQUIRED=false` and
  `enable_vault_secret_loading=false` to bring up `/healthz` before secrets are
  created
- OCI Terraform can either create the default Vault KMS key or reuse an existing
  pre-approved key via `existing_kms_key_ocid`, with secret-sync outputs always
  pointing at the effective key OCID

This is an alternative to direct OpenAI API keys, not a replacement for the
future `codex-cli` adapter. `codex-cli` is an investigation harness/runtime;
OCI GenAI is the model service the existing FirstTrace agent can call.

### Phase 10C: Provider-Neutral Prompt Contract And Quality Metadata

FirstTrace should keep investigation quality behavior above provider-specific
transport code. OpenAI, OCI GenAI, and future model providers should use the
same built-in prompt contract by default, with provider-specific code limited to
API calls, response normalization, JSON parsing, and retry/error handling.

Implemented direction for the package runtime:

- one versioned default investigation prompt contract, currently
  `firsttrace-agent-v1`
- optional additive prompt overlays through `investigation.prompt.overlay_files`
  or `FIRSTTRACE_PROMPT_OVERLAY_FILES`, so npm users can customize domain
  handoff behavior without forking
- prompt overlays cannot remove required safety, citation grounding, or output
  schema rules
- OCI GenAI response handling normalizes provider-wrapped final payloads before
  strict schema parsing and preserves warnings when coercion happens
- AI results can include mixed-audience handoff fields such as `bugLikelihood`,
  `userImpact`, `firstContact`, `relatedChange`, and `confidenceRationale`
- grounded results include computed quality metadata: exact file found, owner
  found, related commit found, citation coverage, and actionability
- `/healthz` exposes non-secret AI readiness metadata: AI gate status, provider,
  model, investigator, safety mode, dry-run mode, prompt profile/version, and
  overlay posture
- compact Slack replies remain short and avoid verbose citation dumps while
  showing user impact and short quality warnings when useful

Example target handoff for manager-first audiences:

```text
Classification: likely bug
Likely owner: Artem Tarasenko
Primary files: app/page.tsx, lib/app-context.tsx
AI confidence: 0.91
User impact: Artist users briefly see an empty profile surface after login.

Likely cause
This is an authenticated artist-profile journey, not a public detail-route issue. The strongest lead is the app shell/bootstrap path that delays profile rendering.

Next checks
1. Inspect app/page.tsx first.
2. Route the first pass to Artem Tarasenko.
3. Confirm whether the blank screen is on the authenticated profile tab.

Evidence
1. Artem Tarasenko - commit 8ce926d, 2026-04-21: Recent routing/bootstrap stabilization touched the artist profile path.
2. app/page.tsx: Entry shell decides when the authenticated profile tab is shown.
3. lib/app-context.tsx: Defines auth/app bootstrap readiness flags.
```

### Later: Codex CLI Investigator Adapter

After the built-in FirstTrace agent is working, add `codex-cli` as an optional
investigator adapter:

```text
FIRSTTRACE_INVESTIGATOR=codex-cli
```

This adapter should use the same `FIRSTTRACE_MODEL_CHAT` value and the same
structured result contract as the built-in agent. The comparison should be about
execution harness quality:

```text
FirstTrace agent + FIRSTTRACE_MODEL_CHAT=<approved model>
vs
codex-cli adapter + FIRSTTRACE_MODEL_CHAT=<approved model>
```

Do not introduce a separate `gpt-5.3-codex` benchmark path at this stage.

The `codex-cli` adapter should only be added after the local Codex CLI install
is verified, because the previously observed local wrapper pointed at a missing
native binary. The adapter can run locally or inside a worker process; Docker is
only a deployment option for keeping that worker alive on a server.

### Later: Work Item Provider

Add a write-capable provider only after triage output is trusted:

```text
WorkItemProvider
  createWorkItem()
  createChildWorkItem()
  linkWorkItems()
  searchWorkItems()
```

Initial write behavior should be explicit-trigger only. The provider interface
should support OCI work items, Jira, GitHub Issues, Linear, or another work item
system without changing the investigation engine.

### Packaging and Deployment Direction

The preferred customer installation path is an npm package plus a small
operations wrapper:

```bash
npm install firsttrace@0.1.5
```

Vercel/Supabase deployments should copy `node_modules/firsttrace/deploy/vercel`
into their own operations repository. That wrapper imports stable FirstTrace
route helpers for Slack events, generic investigation submission, job status,
health, and worker execution from the npm package. Supabase schema is applied
from `node_modules/firsttrace/supabase/migrations` with the Supabase CLI, while
Vercel project/env setup is managed by the packaged Terraform template.

OCI deployments should use a package-based image that installs the published npm
package and copies only deployment config. Both hosted backends should therefore
run from npm artifacts.

Later packaging options:

- prebuilt Docker image once there is enough receiver/worker usage to justify a
  public always-on deployment artifact
- GitHub Container Registry first: `ghcr.io/temaus91/firsttrace`
- Docker Hub later if external adoption needs it

## Queue and Runtime Strategy

Queue implementations should be adapters:

```text
JobQueue
  InMemoryQueue      local tests
  FileSystemQueue    local worker runtime
  SupabaseQueue      Vercel/Supabase hosted path
  RedisQueue         generic Docker Compose
  VercelQueue        Vercel-native users
  OciQueue           OCI Queue work delivery
```

Recommended progression:

1. filesystem or in-memory queue for local development
2. Supabase queue for Vercel/Supabase hosted deployments
3. Redis queue for generic open-source Docker Compose
4. OCI Queue for OCI deployments

The worker should be a normal long-running process. It can run locally, in a
container, in OCI Container Instances, on Kubernetes, or behind another queue
adapter.

For OCI, do not make a database pretend to be a queue. Use OCI Queue as the work
delivery primitive. If long-term queryable history is not required, avoid an OCI
database in the first OCI deployment and rely on:

- Slack thread history for human-readable history
- OCI Queue retention for temporary work delivery
- OCI Object Storage markers for dedupe, processing-message timestamps, and
  final-completion state

Add Autonomous Database only if customers need dashboards, job search, audits,
or retention beyond Slack/Queue.

## Eval Strategy

FirstTrace should be built eval-first because the main risk is not whether a
Slack bot can respond. The main risk is whether the investigation is useful.

Initial eval file:

```yaml
- id: checkout-retry-held-artwork
  report: "Buyer retried checkout after a Stripe redirect failed and the artwork stayed held."
  expected_component: "checkout/public exhibition"
  expected_files:
    - app/api/public-exhibitions/[slug]/checkout/route.ts
    - lib/server/checkout/resume-cookie.ts
    - lib/server/checkout/reconcile-session.ts
  expected_owner: "@checkout-platform"
```

Useful metrics:

- classification accuracy
- top-3 expected file recall
- top-5 expected file recall
- owner match
- component match
- citation coverage
- unsupported claim count
- agent step count and timeout rate
- safe-command usage rate
- cited commit/blame usefulness
- write-action precision for bug/work-item creation evals
- result length

Near-term evals should compare:

```text
evidence mode + FIRSTTRACE_MODEL_CHAT=<approved model>
vs
FirstTrace agent mode + FIRSTTRACE_MODEL_CHAT=<approved model>
```

Later evals may compare:

```text
FirstTrace agent mode + FIRSTTRACE_MODEL_CHAT=<approved model>
vs
codex-cli mode + FIRSTTRACE_MODEL_CHAT=<approved model>
```

Do not add a `gpt-5.3-codex` benchmark until there is a specific customer or
quality reason to justify the extra model path.

## External Integration Test Backlog

Some provider paths require live credentials or a dedicated external project, so
they should stay tracked explicitly until they are tested end to end. These
checks should use local ignored config files and environment secrets only.

### Vercel/Supabase Live Acceptance - Harness Ready

Current status:

- hosted readiness runner passes with filesystem queue
- unit tests cover Supabase row mapping, RPC claim behavior, status lookup, and
  receiver behavior through fakes
- filesystem queue smoke tests pass
- `firsttrace hosted accept --backend vercel-supabase` verifies health/build
  metadata, Slack dedupe, one processing reply, one final reply, and job success
- no current fresh npm-wrapper Vercel/Supabase live acceptance result is
  recorded in this repo
- live Supabase queue processing should be accepted only after the deployed
  wrapper has all packaged FirstTrace migrations applied in order

Prerequisites:

- a dedicated Supabase project or database for FirstTrace runtime state
- all packaged migrations applied in order, including
  `0001_firsttrace_jobs.sql`, `0002_firsttrace_job_dedupe.sql`, and
  `0003_firsttrace_claim_next_empty.sql`
- local acceptance environment values:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `FIRSTTRACE_QUEUE_PROVIDER=supabase`
  - `FIRSTTRACE_CONFIG_PATH=firsttrace.config.yaml`

Smoke test:

```bash
firsttrace submit \
  --queue supabase \
  --config firsttrace.config.yaml \
  --report "README deployment plan is unclear"

firsttrace worker run --once --queue supabase

firsttrace worker status --queue supabase --job <job-id>
```

Expected result:

- job is inserted into `firsttrace_jobs`
- worker claims the queued job through `firsttrace_claim_next_job()`
- job moves from `queued` to `running` to `succeeded`
- stored result includes deterministic investigation evidence
- no service-role key or source snippets appear in logs or committed files

### GitHub App Repository Live Test - Complete Through OCI Acceptance

Current status:

- hosted readiness runner reports GitHub App env as blocked when credentials are
  missing
- unit tests cover config parsing, private-key newline normalization, missing
  env errors, token-safe git command construction, fake materialization, eval,
  and worker paths
- local repo smoke tests still pass
- OCI live acceptance has exercised the configured GitHub-backed investigation
  path through the deployed worker
- each new deployment should still verify its own GitHub App installation and
  repository access

Prerequisites:

- GitHub App installed on a test repository with read-only Metadata and Contents
  permissions
- `.env.local` values:
  - `GITHUB_APP_ID`
  - `GITHUB_APP_INSTALLATION_ID`
  - `GITHUB_APP_PRIVATE_KEY`
  - or local-only `GITHUB_TOKEN`
- ignored local config such as `firsttrace.github.local.yaml`:

```yaml
repos:
  - name: example-app
    provider: github
    owner: exampleco
    repo: web-app
    default_branch: main
docs:
  - README.md
  - docs
issue_exports: []
owners:
  - path: README.md
    owner: "@project-docs"
search:
  max_files: 10
  max_commits: 8
  max_evidence_per_file: 3
```

Smoke test:

```bash
firsttrace investigate \
  --config firsttrace.github.local.yaml \
  --report "README deployment plan is unclear"
```

Expected result:

- repo materializes under ignored `.firsttrace/github/`
- GitHub installation token is used only through `git -c http.extraHeader`
- token is not stored in the remote URL, git config, job JSON, output, or logs
- investigation returns file and commit evidence from the GitHub repo
- owner rules from the config are applied to returned files

### Slack Hosted Event Live Test - Complete For OCI, Harness Ready For Vercel/Supabase

Current status:

- hosted readiness runner verifies a synthetic signed Slack event and captures a
  fake Slack reply locally
- unit tests cover Slack signature verification, URL verification, bad
  signatures, configured channel gating, app mention enqueueing, top-level
  message behavior, reaction message fetch, and Slack thread reply rendering
- worker tests cover posting a completed investigation through a fake Slack
  client
- OCI live acceptance verifies real Slack Events delivery and `chat.postMessage`
  through the deployed API Gateway and worker
- Vercel/Supabase has the equivalent `hosted accept --backend vercel-supabase`
  command and still needs a fresh live pass against the npm-wrapper deployment

Prerequisites:

- Slack app installed in a test workspace and invited to the configured channel
- Slack Event Subscriptions pointed at `/api/slack/events`
- `.env.local` or hosted env values:
  - `SLACK_SIGNING_SECRET`
  - `SLACK_BOT_TOKEN`
  - `FIRSTTRACE_QUEUE_PROVIDER=oci` for OCI acceptance, `supabase` for the
    Vercel/Supabase path, or `filesystem` for local receiver testing
  - `FIRSTTRACE_CONFIG_PATH=<config path>`
- config with:
  - `chat.provider: slack`
  - configured channel id
  - trigger list containing the trigger being tested
  - `ai_enabled` set explicitly for the channel

Smoke test:

```text
1. Send Slack URL verification to /api/slack/events.
2. Post a top-level bug report in the configured Slack channel.
3. Confirm the receiver enqueues a job and returns quickly.
4. Run the worker against the same queue.
5. Confirm the worker posts a cited FirstTrace reply in the Slack thread.
6. Post from an unconfigured channel and confirm it is ignored or safely declined.
```

Expected result:

- invalid signatures are rejected before parsing or enqueueing
- configured events create queued jobs with `source.provider=slack`
- unconfigured channels do not create jobs
- worker result is stored and posted back to the correct channel/thread
- no Slack tokens, signing secrets, or private source snippets appear in logs or
  committed files

## Security and Privacy

FirstTrace is intended for private codebases, so security has to be part of the
design from the start:

- request read-only repo access by default
- support local/internal git repositories without GitHub dependency
- avoid logging source snippets unnecessarily
- make LLM inputs inspectable
- allow teams to choose where the worker runs
- store secrets in the host platform, not in config files
- make external API calls explicit and configurable

The first version can be simple, but it should avoid assumptions that would make
private-repo deployment hard later.

## Open-Source and Enterprise Model

The open-source core should include:

- CLI investigation flow
- local git provider
- ownership file support
- eval runner
- basic worker
- Slack adapter when ready
- Redis or simple queue adapter

Potential enterprise features:

- hosted control plane
- admin UI and run history
- SSO and audit logs
- fine-grained source redaction
- advanced Jira/Linear/ServiceNow integrations
- private model/provider controls
- scheduled repo indexing
- organization-wide ownership graph
- support contracts

Apache License 2.0 allows enterprise use while preserving room for a commercial
offering around hosting, integrations, support, and proprietary enterprise
features.

## Future TODOs

The 0.1.6 manager-owner triage scope above is implemented. The following items
remain future work and should stay aligned with PM/manager triage as the primary
product surface:

1. Parse CODEOWNERS and optional `firsttrace.owners.yaml` automatically, then
   map team aliases to Slack users, emails, Jira components, or escalation
   groups.
2. Add configurable retention and data-minimization controls for stored reports
   and results across OCI Object Storage, Supabase, and filesystem queues.
3. Add live Jira, GitHub Issues, OCI work-item, and fixture issue-provider
   adapters behind one generic issue-provider interface.
4. Add a generic read-only `provider: git` clone/fetch adapter or an external
   provider extension API for enterprise-specific repository sources.
5. Add the later `codex-cli` investigator adapter only after the built-in agent
   path has clear quality gaps, using the same `FIRSTTRACE_MODEL_CHAT` value.
6. Add broader release gates once there are more public and private
   historical-bug eval cases.

## Open Questions

- Should the CLI be the same binary/process as the worker?
- What is the minimum useful ownership file format?
- Should the first issue provider be Jira, GitHub Issues, or fixtures only?
- Which provider metadata adapter should follow GitHub once the generic
  interface is proven?
