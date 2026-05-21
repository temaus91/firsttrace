# FirstTrace Product Plan

FirstTrace is a self-hosted bug localization tool for teams with private,
internal, or public git repositories. It turns a messy bug report from chat,
CLI, or another source into a cited first investigation trail: likely component,
suspicious files, likely owner, related issues, and suggested next steps.

This document is the working blueprint. The README explains the project at a
high level; this plan describes what to build and in what order.

## Product Thesis

The first hour of debugging is usually evidence gathering, not coding. Engineers
read a vague bug report, search code, inspect recent commits, check ownership,
look through related tickets, and then ask the right person to investigate.

FirstTrace should automate that first pass without pretending to fix the bug.
The product wins when it gives a useful, cited starting point faster than a human
triager could assemble one manually.

## Design Principles

- **Evidence first:** every important claim should link back to a file, commit,
  owner rule, issue, or source message.
- **Read-only by default:** v0 should not write code, create tickets, or mutate
  customer systems.
- **Self-hostable:** teams should be able to run it near their private repos and
  internal systems.
- **Runtime-portable:** Slack, Jira, GitHub, Supabase, Redis, OCI, and Vercel are
  adapters, not core assumptions.
- **Eval before integrations:** the core investigation engine should prove it
  can find useful files and owners before Slack or other chat integrations.
- **Small trusted output:** a concise, grounded reply is better than a long,
  speculative report.

## Non-Goals

FirstTrace v0 is not:

- an autonomous coding agent
- a ticket-writing or ticket-routing system
- a generic workplace search product
- a replacement for on-call engineers
- a SaaS-only product
- a tool that needs write access to source code
- a workflow engine like Temporal

Fix suggestions, ticket creation, dashboards, scheduled indexing, and enterprise
admin features can come later.

## Architecture

```mermaid
flowchart TD
  Source["Input Source<br/>CLI, Slack, later Teams/Discord"] --> Request["Investigation Request"]
  Request --> Engine["Investigation Engine"]

  Engine --> Git["Git Provider<br/>local repo, internal git, GitHub"]
  Engine --> Owners["Ownership Provider<br/>CODEOWNERS, firsttrace.owners.yaml"]
  Engine --> Issues["Issue Provider<br/>Jira, GitHub Issues, fixtures"]
  Engine --> Reasoner["Reasoner<br/>OpenAI or compatible LLM"]

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
schemas. The important boundary is that providers return evidence, and the
reasoner ranks evidence instead of inventing facts.

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

IssueProvider
  searchIssues(query)
  getIssue(id)

Reasoner
  rankEvidence(request, evidence)
  summarizeResult(request, rankedEvidence)

OutputAdapter
  render(result)
  send(result)
```

Initial providers should be deliberately simple:

- local git provider using the checked-out repository
- ownership YAML provider using `firsttrace.owners.yaml`
- fixture issue provider for evals
- OpenAI reasoner
- CLI/markdown output adapter

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

## Phased Roadmap

### Phase 1: Local CLI Spike

Build the smallest useful local flow:

```bash
firsttrace investigate \
  --repo /path/to/repo \
  --report "checkout retry leaves the artwork held"
```

The command should:

1. read the report text
2. classify the report as bug, feature request, support question, or unknown
3. search files and commits in the repo
4. load ownership metadata
5. ask the reasoner to rank evidence
6. print a concise result with citations

No Slack, no queue, no Docker, no npm publishing yet.

### Phase 2: Evidence and Eval Runner

Add eval cases before production integrations:

```bash
firsttrace eval \
  --repo /path/to/repo \
  --cases evals/private-repo.yaml
```

The eval runner should score:

- classification matched
- expected files found in top results
- expected owner found in top results
- expected component matched
- citations present for claims
- hallucinated or unsupported claims avoided
- bug/work-item metadata quality when write-capable skills are tested

The first dogfood corpus can be any private repository with known historical
bugs, expected files, expected owners, and known final outcomes. Public docs
should describe this generically; customer- or company-specific eval cases should
stay private.

### Phase 3: Channel Profiles and Skill Definitions

Add generic configuration files that describe channel behavior and task behavior:

```text
channel.md
  channel goals
  expected message types
  SME/DRI ownership mapping
  response preferences
  enabled providers

skills/triage.md
  classify feedback
  determine owner
  gather evidence
  suggest next action

skills/log-a-bug.md
  create a validated work item when explicitly triggered
  fill title, description, owner, area, tags, severity, and priority
  link evidence back to the source thread
```

These files should be generic and provider-neutral. A deployment can bind them
to Slack, Teams, OCI work items, Jira, GitHub Issues, or another provider.

### Phase 4: Local Dogfood Against a Private Repo

Use a real private repository as a read-only dogfood target:

```bash
firsttrace eval \
  --repo /path/to/private/repo \
  --cases /path/to/private/evals.yaml
```

Goals:

- prove the tool can localize real historical bugs
- validate ownership mapping
- validate classification quality
- validate citation quality
- tune prompts and ranking before chat integration

This phase should not require publishing private repo names, private bug reports,
or customer-specific provider details in the public repository.

### Phase 5: Runtime Worker

After the CLI and eval runner work, add an asynchronous runtime:

```text
Receiver -> JobQueue -> Worker -> OutputAdapter
```

Minimum worker behavior:

- enqueue request
- mark job running
- run investigation
- mark succeeded or failed
- retry failed jobs with an attempt limit
- keep enough run history to debug failures

Temporal is not needed for v0. A simple worker plus queue/status tracking is
enough until investigations become long-running, multi-step, or human-involved.

### Phase 6: Chat Adapter and Triggers

Slack can be the first chat adapter, but the core product should stay generic:

```text
Slack app mention -> Receiver -> Queue -> Worker -> Slack thread reply
```

The first chat adapter should:

- verify incoming requests
- acknowledge quickly
- fetch thread context
- enqueue an investigation request
- post or return the result
- support explicit triggers such as at-mentions and emoji reactions
- optionally support automatic triage on top-level messages

The investigation engine should remain chat-agnostic so Teams, Discord, Linear,
or other sources can be added later.

### Phase 7: Work Item Provider

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

### Phase 8: Packaging and Deployment

Packaging comes after the tool is useful locally:

- `package.json` for development once the implementation starts
- npm publishing once the CLI is useful to external users
- Docker image once there is a real receiver/worker to run
- GitHub Container Registry first: `ghcr.io/temaus91/firsttrace`
- Docker Hub later if external adoption needs it

## Queue and Runtime Strategy

Queue implementations should be adapters:

```text
JobQueue
  InMemoryQueue      local tests
  RedisQueue         generic Docker Compose
  SupabaseQueue      Vercel/Supabase dogfood path
  VercelQueue        Vercel-native users
  OciQueue           OCI deployments
```

Recommended progression:

1. in-memory queue for local development
2. Redis queue for generic open-source Docker Compose
3. Supabase queue for Vercel/Supabase dogfood deployments
4. OCI queue for OCI deployments

The worker should be a normal long-running process. It can run locally, in a
container, in OCI Container Instances, on Kubernetes, or behind another queue
adapter.

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
- write-action precision for bug/work-item creation evals
- result length

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

## Immediate Next Steps

1. Keep Phase 1 deterministic CLI behavior stable while testing local reports.
2. Add the eval runner and eval case format.
3. Add the first private-repo eval cases outside the public repository.
4. Run evals before adding chat integrations.
5. Add OpenAI-backed ranking only after deterministic eval baselines exist.

## Open Questions

- Should v0 be TypeScript-first, Java-first, or another runtime?
- Should the CLI be the same binary/process as the worker?
- How much source text should be sent to the LLM by default?
- Should we support local-only/no-LLM scoring as a baseline?
- What is the minimum useful ownership file format?
- Should the first issue provider be Jira, GitHub Issues, or fixtures only?
- What result format should become the stable external contract?
