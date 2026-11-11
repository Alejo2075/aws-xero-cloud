# CLAUDE.md — Xero

> Instructions for Claude Code and other coding agents working in the Xero repository.
> Xero is an open-source, self-hosted, distributed runtime for AWS Lambda-style functions.

## 1. Project identity

**Name:** Xero  
**Working description:** Open-source hybrid Lambda-compatible compute runtime  
**Tagline:** Your hardware. Your Lambdas. One cloud experience.  
**Model:** Open source, self-hosted, AWS-integrated, developer-controlled  
**Stewardship:** Independent Cloud Republic OSS project. Sponsorship must never be a runtime dependency.

Xero turns a laptop, workstation, on-premises server, or cloud VM into a serverless function executor that interoperates with native AWS Lambda and AWS services.

**AWS interoperability is a product-defining requirement, not a distant optional feature.** A single **logical Xero function** may have a local deployment, a native AWS Lambda deployment, or both. Xero exposes a unified invocation and management experience and routes supported invocations to the chosen deployment according to an explicit policy.

Xero provides **function compute only**. It does not replace AWS services, build a full PaaS, or implement a general cloud provider. Functions running on Xero should be able to use real AWS services through official SDKs and appropriately scoped AWS credentials.

The engine is the product. CLI, API, SDK, and optional UI are interfaces over the same engine.

### Non-negotiable product promise

A developer can run a supported Lambda-style handler locally, connect an AWS account, call AWS services and existing AWS Lambda functions, and register both local and native AWS Lambda deployments under one logical function identity. The developer controls where new invocations go and can eventually use policy-driven hybrid placement.

**Compatibility language must be precise:** Xero does not join the AWS Lambda managed fleet. A local execution is not an AWS Lambda instance; the *same logical function* is represented by two separate physical deployments. Xero cannot force native Lambda aliases, AWS Lambda ARNs, or managed event-source mappings to route to a local machine. Integration requires a Xero-controlled entrypoint, supported service adapter, or explicit AWS-side bridge.

## 2. Mission and vision

### Mission

Make Lambda-style function compute portable across hardware users already own and AWS Lambda, while preserving interoperability with the AWS services and functions developers already use.

### Long-term vision

A user-owned **hybrid function fabric** with a single logical function catalog, common handler and artifact contracts, explicitly controlled routing, and secure execution targets spanning local machines, private servers, and native AWS Lambda.

The intended product milestones are:

1. **Local execution:** run Node.js/Python Lambda-style handlers safely on one machine.
2. **AWS-connected execution:** access actual AWS resources and invoke existing native AWS Lambda functions.
3. **One logical function, two targets:** register the same function for local and native Lambda execution, then select the target by request or fixed policy.
4. **AWS-origin events:** deliver supported AWS service events to Xero through safe, explicitly configured adapters (starting with SQS).
5. **Distributed/hybrid scheduling:** add more local/cloud nodes, traffic splitting, overflow/failover, and cost/latency-aware placement.

A non-AWS installation must remain useful. Using AWS must be opt-in, with clear costs and permissions. Do not defer AWS interoperability from the architectural contracts merely because the production-grade hybrid scheduler will ship later.

## 3. Product boundaries

### Xero does

- Package, deploy, register, invoke, observe, update, and remove supported function deployments.
- Run Lambda-compatible handlers locally in isolated, resource-limited workers.
- Integrate with **existing native AWS Lambda functions**, including invocation by qualified ARN/alias where supported.
- Maintain a **logical function** identity with explicit local and/or AWS Lambda targets.
- Enable local functions to use actual AWS services via official SDKs and short-lived, least-privilege credentials.
- Receive selected AWS-originated events using adapters or bridges, without reinventing those services.
- Manage concurrency, timeouts, cold starts, idle worker lifecycle, and local scale-to-zero.
- Eventually distribute work among nodes and native AWS Lambda according to explicit policy.
- Expose stable core contracts through a CLI, API, and SDK.

### Xero does NOT do

- Implement S3, DynamoDB, SQS, SNS, EventBridge, Step Functions, API Gateway, IAM, or any other AWS service as a Xero product.
- Replace existing Lambda resources, identifiers, native aliases, or source integrations transparently.
- Claim that AWS can run part of **one in-progress invocation** on premises and the rest in Lambda without explicit application-level orchestration. Hybrid routing distributes **invocations** among deployments.
- Promise native Lambda and local workers have identical runtimes, networking, IAM context, limits, billing, or event mappings.
- Create managed customer accounts, central billing, a mandatory hosted SaaS, or hidden sponsor dependencies.
- Provision chargeable AWS resources, modify triggers, or switch traffic without an explicit authorized plan/action.
- Expose arbitrary local services to the internet by default.
- Require Kubernetes for the single-node experience.

Internal coordination queues and metadata stores are allowed as implementation details. **AWS SQS and other services are integrations, not new Xero-managed cloud products.**

### Adjacent OSS products

- Xero is useful without Hero, Zerverless, or Cloud Republic services.
- Other products may call Xero through documented APIs/SDKs.
- Avoid confusion with any infrastructure-as-prompt product previously called Xero: branding/consolidation requires an explicit decision.

## 4. Engineering principles

1. **Functions only:** never expand the product into a generic cloud service catalogue.
2. **Hybrid by design:** local and AWS Lambda are first-class invocation targets behind common interfaces.
3. **Logical identity ≠ physical deployment:** multiple deployments may back one Xero function; each has its own version, runtime details, permissions, and lifecycle.
4. **Single-node simple:** no AWS account or Kubernetes required to start using Xero locally.
5. **AWS-native interoperability:** prefer official AWS SDK/API integration; do not emulate AWS services when the real service can be called.
6. **Precise compatibility:** describe supported Lambda handler/event/context features and runtime differences through an evidence-backed matrix.
7. **Explicit routing:** never change function target, traffic split, or fallback without policy; deterministic routing is the baseline, not AI.
8. **Secure connectivity:** authenticated and encrypted ingress/egress; no open local ports or long-lived AWS keys by default.
9. **Least privilege per function:** avoid giving function code the controller's broad credentials or an unconstrained AWS identity.
10. **Container-based isolated local execution:** use existing execution primitives, not a custom operating system.
11. **Visible scaling:** local cold starts, timeouts, capacity limitations, and any AWS spillover must be observable.
12. **Provider boundaries:** cloud adapters, identity providers, transport bridges, and execution backends must remain independent of the core.
13. **Operator ownership:** deployments, credentials, artifacts, and routing rules stay under the user's control.
14. **Honest delivery:** make a working AWS-connected vertical slice before adding a complex multi-node scheduler.
15. **Open source independence:** no mandatory AI, proprietary account, or sponsor control plane.

## 5. MVP v0.1 — minimum viable hybrid runtime

The MVP must demonstrate actual hybrid interoperability, **not just a function running in Docker**. Keep the implementation narrow while making AWS integration tangible from the first release.

### Required features

**Local execution**

- Single-host, developer-controlled runtime using a supported container engine.
- Linux runtime; macOS development supported via a local Linux container engine/VM.
- AWS Lambda-style Node.js and Python handlers for explicitly supported versions.
- Immutable function artifacts, deployment registry, local invocation, safe timeout/resource/concurrency limits, structured logs, and basic metrics.
- CLI commands for deployment, inspection, invocation, logs, update, and removal.
- On-demand startup, warm reuse when appropriate, and idle scale-to-zero.
- Local metadata that survives controller restart.

**AWS interoperability**

- Connect an explicitly selected AWS profile/identity and region through official SDK credential-provider mechanisms; no mandatory AWS connection.
- Demonstrate that a local handler accesses a real AWS service (for example, DynamoDB or S3) using temporary scoped credentials. SDK usage remains normal application code, not a Xero reimplementation.
- Invoke a registered **existing native AWS Lambda** from Xero, using AWS Lambda's actual Invoke API, honoring authorization, region, payload/response behavior, and target errors.
- Register one logical Xero function with both `local` and `aws-lambda` deployments. Support explicit target selection and a documented static default target; no automatic traffic splitting required yet.
- Provide a **single narrow AWS-to-local event path** using an opt-in SQS consumer adapter. Correctly handle at-least-once delivery, visibility, retry, successful acknowledgment, and poison messages without pretending SQS is an internal Xero service.
- Make external AWS usage and costs visible. No automatic Lambda creation, CloudFormation stack, IAM role, SQS queue, or network resource creation in v0.1.
- Supply local/mocked AWS integration tests and clearly labeled optional tests against a disposable AWS test environment.

### Explicitly deferred beyond v0.1

- Automatic native Lambda deployment or synchronizing deployments from one artifact to both targets.
- Weighted routing, adaptive routing, capacity-driven cloud bursting, and automatic failover.
- AWS-origin direct HTTP ingress through EventBridge/API Gateway, private network bridges, Step Functions HTTP Task bridges, and additional event-source adapters.
- Production distributed control-plane HA, multiple worker nodes, and K3s/Kubernetes integration.
- Full Lambda Runtime API parity, Lambda aliases/versions control, extensions/layers parity, and all AWS trigger types.
- Enterprise multitenancy/billing, AI scheduling, edge fleets, GPU/WASM, and a large hosted dashboard.

Do not implement deferred features without an approved change to `docs/product/mvp.md` and an ADR. **Never defer the core `local + existing AWS Lambda + AWS service access` contract.**

## 6. User experience contract

Aim for **one function name, explicit targets, predictable execution**. The following commands are illustrative design targets, not claims about implemented CLI syntax:

```bash
# Local-first: no AWS account needed.
xero deploy ./examples/hello --name hello --target local
xero invoke hello --target local --payload '{"name":"Ada"}'

# Opt into AWS interoperability using an operator-selected identity.
xero aws connect --profile development --region us-east-1
xero functions bind hello --target aws-lambda \
  --arn arn:aws:lambda:us-east-1:123456789012:function:hello

# One logical name, two independently addressable targets.
xero invoke hello --target aws-lambda --payload '{"name":"Ada"}'
xero invoke hello --target local --payload '{"name":"Ada"}'

# Optional AWS-origin event source: queue must already exist.
xero events attach hello --source sqs --queue-url <existing-queue-url>
```

Example *proposed* function spec (schema not yet frozen):

```yaml
apiVersion: xero.dev/v1alpha1
kind: Function
metadata:
  name: process-order
spec:
  runtime: nodejs
  handler: index.handler
  deployments:
    local:
      artifact: ./functions/process-order
    aws-lambda:
      mode: existing
      arn: arn:aws:lambda:us-east-1:123456789012:function:process-order:live
  routing:
    strategy: manual
    defaultTarget: local
```

A common logical name does **not** erase environment differences. Each target must publish its own status, version, timeout, permissions, and configuration. Prevent accidental routing to incompatible versions or targets without permissions.

Example Node.js Lambda-style handler using a real AWS SDK:

```ts
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
const dynamodb = new DynamoDBClient({}); // Resolves credentials per environment.

export const handler = async (event: { id: string }) => {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME!,
    Key: { id: { S: event.id } },
  }));
  return { found: Boolean(result.Item) };
};
```

The same handler code is a compatibility goal, not a promise that environment variables, IAM identities, network paths, packages, or deployment artifacts are automatically identical. **Do not ship sample credentials or hardcode IAM access keys.**

## 7. Core architecture

### Unified hybrid invocation

```text
             CLI / SDK / App / AWS-origin event
                           |
                       Ingress
           (local HTTP / SQS / future bridges)
                           |
              Xero Controller + Registry
                           |
                  Logical Function
                    process-order
                           |
                Policy / Target Router
                           |
               +-----------+-----------+
               |                       |
           Local Target             AWS Target
         Xero Worker Pool       Native AWS Lambda
           handler()              Invoke API
               |                       |
               +-----------+-----------+
                           |
              Real AWS service APIs
          S3 / DynamoDB / SQS / others
         (normal SDK calls with scoped IAM)
```

An AWS-hosted Xero worker running on EC2 is a **third** execution target (Xero worker on AWS infrastructure), not native Lambda. Never conflate it with the `aws-lambda` target.

### Major components

- **Controller:** orchestrates APIs and services without hiding target-specific behavior.
- **Logical function registry:** stable name and common contract, mapping to independent deployment targets/versions/aliases.
- **Artifact/deployment registry:** immutable artifacts, target status, metadata, and compatibility evidence.
- **Hybrid invocation router:** resolves Xero logical function -> explicit target, enforces policy and concurrency constraints, preserves correlation IDs.
- **Local execution backend:** container-based worker lifecycle, warm reuse, timeout, and idle scaling.
- **AWS Lambda target adapter:** calls AWS Lambda's official Invoke API; maps AWS-specific failures without presenting local behavior as native Lambda.
- **AWS identity provider:** resolves refreshable, scoped credentials for the controller and local workers without leaking controller privileges.
- **AWS event-source connector:** receives events for Xero functions through an opt-in consumer/bridge, starting with SQS.
- **Runtime adapters:** implement supported Node.js/Python handler and context conventions.
- **Telemetry:** logs, metrics, target selection, execution location, cold starts, cost-relevant AWS requests, and trace correlation.
- **Scheduler/scaler:** local capacity and limits first; later placement across distributed nodes and native Lambda.

### Architectural invariants

- The **routing decision happens before execution**. No automatic migration of a running invocation between local and AWS.
- Version/capability incompatibility is detected and surfaced, not silently ignored.
- Caller-visible semantics explicitly distinguish synchronous invocation, asynchronous acceptance, retries, and side effects.
- External AWS events reach local workers only through configured reachable/authenticated paths or polling bridges; Xero never promises AWS-managed triggers will magically invoke local workers.
- Failure of the AWS control plane/network must not prevent purely local functions from running when they have no AWS dependency.
- Function-to-function calls may be made via the Xero SDK/router; functions that use `LambdaClient.Invoke` directly continue to target **native Lambda** unless they explicitly adopt a Xero routing adapter.

## 8. Recommended repository structure

Use a TypeScript-first monorepo with strict package boundaries. Do not create empty packages merely to match this proposal.

```text
xero/
├── apps/
│   ├── cli/                       # User-facing CLI
│   └── controller/                # Local management + invocation API
├── packages/
│   ├── core/                      # Domain services and ports
│   ├── specification/             # Logical function/deployment schemas
│   ├── registry/                  # Persistence + version/target mapping
│   ├── artifacts/                 # Artifact packaging and validation
│   ├── invocation/                # Invocation contracts and router
│   ├── scheduler/                 # Local capacity/placement policy
│   ├── scaling/                   # Warm workers + scale-to-zero
│   ├── execution/                 # Execution backend interfaces
│   ├── executor-docker/           # Local container worker backend
│   ├── runtime-node/              # Node.js handler adapter
│   ├── runtime-python/            # Python handler adapter
│   ├── aws-identity/              # Temporary AWS credentials/identity
│   ├── target-aws-lambda/         # Native Lambda invoke target adapter
│   ├── event-source-sqs/          # AWS SQS -> Xero local adapter
│   ├── telemetry/                 # Target-aware logs/metrics/tracing
│   ├── sdk/                       # Public TypeScript SDK
│   └── shared/                    # Small, justified shared utilities
├── examples/
│   ├── node-hello/
│   ├── python-hello/
│   └── hybrid-process-order/
├── tests/
│   ├── contracts/
│   ├── integration/
│   ├── aws-disposable/            # Explicit opt-in real AWS suite
│   └── e2e/
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── integrations/aws/
│   ├── security/
│   ├── adr/
│   └── rfcs/
├── .github/
├── CLAUDE.md
├── AGENTS.md
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

### Dependency rules

- `apps/*` call SDK/core contracts; they do not implement scheduling or cloud dispatch logic.
- `core`, `specification`, `invocation`, `scheduler`, and `scaling` do not import the AWS SDK, Docker, Kubernetes, or frontend frameworks.
- AWS SDK-specific code lives inside AWS integration/target packages.
- Neither `target-aws-lambda` nor `executor-docker` knows about CLI flags or web pages.
- `aws-identity` exposes an isolated, audited credential-provider contract, not global credentials.
- The logical function registry does not equate an AWS ARN with a Xero logical function identifier.
- New connectors require contract tests and a narrowly documented AWS permission policy.
- Avoid circular dependencies and private deep imports.

## 9. Function and invocation model

### Logical function versus deployment

Each logical function has:

- Stable Xero ID/name, handler signature, event/result contract, and desired configuration.
- One or more independently versioned deployment targets (`local`, `aws-lambda`, later `xero-node`).
- Per-target artifact reference, runtime/capability metadata, region, identity, status, and limits.
- Explicit routing policy and a default target.
- Environment/secret mapping per target; never assume identical host files, IAM roles, network access, or environment variables.

For an existing AWS Lambda binding, store the actual qualified ARN/alias and verify it through read-only AWS API calls where allowed. Treat AWS's own deployed code/version as external: do not claim Xero built or controls it.

### Invocation lifecycle

```text
Request / AWS-origin event
  -> Authenticate and authorize caller/source
  -> Resolve logical function and target policy
  -> Validate payload, version/capability, deadline and quota
  -> Choose exactly one target for this attempt
      local -> reserve capacity -> cold/warm worker -> handler
      aws   -> signed Lambda Invoke API -> native Lambda
  -> Preserve correlation IDs, record selected target/attempt
  -> Normalize status/result only where semantics really match
  -> Apply explicit acknowledgment/retry policy
```

### Required invariants

- Local timeouts must stop or reliably fence the worker, not just the HTTP connection.
- Worker crashes never crash the controller or other workers.
- Backpressure is bounded; host exhaustion and AWS throttling are distinct error types.
- No implicit replay/failover of a potentially completed non-idempotent invocation.
- Retries require explicit policy, an idempotency strategy, and accurate handling of unknown outcomes.
- `requestId`, logical `functionId`, `deploymentId`, `target`, `attemptId`, and trace context are available for correlation where technically possible.
- No secrets, credentials, raw event bodies, or response bodies in default logs.
- SQS events are acknowledged/deleted only after the intended processing outcome; visibility timeout, partial batch failures, duplicates, and DLQ behavior are documented and tested.

### Lambda compatibility contract

Document a tested matrix for:

- Handler export resolution, invocation payload, result/exception, and context-field subset.
- Supported Node.js/Python runtime versions, platform architecture, dependency packaging, and environment handling.
- Differences in temporary storage, system libraries, network routes, IAM credentials, cold starts, event formats, timeouts, and quotas.
- For native Lambda targets, keep AWS's actual Invoke semantics (including `InvocationType` and `FunctionError`) rather than hiding the differences behind misleading success codes.

Do **not** claim full AWS Lambda API, runtime lifecycle, event-source mapping, layer, or extension parity without conformance tests.

## 10. Storage, state, and data ownership

- Keep v0.1 state local to the host using a simple embedded persistence mechanism where appropriate.
- Persist metadata and immutable artifact references; function application data is not a managed Xero database.
- Define migration/versioning for persistent state.
- Never treat ephemeral worker filesystem data as durable function state.
- Make deletion and cleanup predictable, including worker images, artifacts, and logs.
- In future distributed mode, do not assume an embedded single-host store is sufficient for HA or cross-node coordination.

## 11. Scaling and scheduling

### v0.1

- Single-host concurrency-aware scheduling.
- Per-function concurrency caps and global host resource bounds.
- Controlled cold starts and optional warm reuse.
- Configurable idle TTL and eventual scale-to-zero.
- Observability for cold/warm requests and capacity rejections.

Scale-to-zero means **zero running function workers when idle**; it does not mean the controller itself disappears or that an idle host can accept invocations without a live ingress/controller.

### Future distributed requirements

- Explicit node join/leave and authentication.
- Heartbeats/leases and stale-node detection.
- Resource-aware placement with capacity accounting.
- Artifact distribution and version pinning.
- Worker restart/rescheduling with documented in-flight invocation behavior.
- Network failure and split-brain handling.
- Optional K3s/Kubernetes backend behind `ExecutionBackend`/cluster contracts.

Prefer proven orchestration components over building a custom cluster orchestrator unless a documented technical gap justifies the cost. K3s is an option, not the product's defining feature.

## 12. AWS integration and hybrid function fabric — core requirement

### 12.1 The product's three concrete integration modes

**Mode A — Local handler uses actual AWS services**

A Node.js/Python function running on a Xero worker uses the official AWS SDK to call Amazon S3, DynamoDB, SQS, EventBridge, Secrets Manager, or a native Lambda, exactly as any external authorized workload would. Xero manages secure credential delivery and optional network configuration; it does **not** recreate those AWS services. Access is limited by IAM and the service's endpoint/network policy.

**Mode B — Xero invokes existing native AWS Lambda**

Register an existing Lambda qualified ARN as a deployment target. The controller/authorized invocation adapter calls the Lambda Invoke API. Permissions, region, credentials, payload limits, invocation mode, concurrency, cost, and native failure semantics remain AWS's responsibility. This must work even if Xero did not deploy the native Lambda.

**Mode C — One logical function backed by local + AWS Lambda**

Xero's registry binds two separately deployed instances of the same intended handler/function contract. Xero's routing layer decides **per invocation** whether to run locally or invoke the native AWS deployment. Initial policy: manual or fixed-default target. Later policies: explicit weights, capacity-based bursting, controlled failover, geography, locality, or user-defined rules.

```text
Logical function: process-order
  deployment local       -> Xero worker on my server
  deployment aws-lambda  -> arn:aws:lambda:...:function:process-order:live

Incoming Xero-managed invocation
  -> policy + validation -> local OR native AWS Lambda
```

This is **not** a hybrid single AWS Lambda deployment, an extension of a native Lambda alias to local, nor a runtime split inside one in-flight invocation.

### 12.2 AWS -> local event ingress

AWS cannot invoke local Xero handlers through a normal Lambda ARN or event-source mapping. Add specific bridges:

| AWS entry/event | Supported Xero integration approach | Delivery caveat |
|---|---|---|
| SQS message | Xero's opted-in poller receives messages and runs a local handler | At least once, duplicates possible; visibility and DLQ required |
| EventBridge event | Explicit API Destination/connection to a reachable secured Xero endpoint, or route through SQS | Auth/network setup required; no default open ports |
| API Gateway request | HTTP integration to an explicitly reachable Xero ingress/bridge, with appropriate API auth | Private VPC link is not a direct arbitrary on-premise endpoint |
| Step Functions state | HTTP Task with EventBridge Connection, or a designated Lambda bridge | Task-specific limits and networking apply |
| S3/DynamoDB-triggered native Lambda | Dedicated bridge Lambda that forwards/events to Xero, or applicable supported downstream event route | Existing managed trigger does not target local Xero directly |
| Native Lambda -> Xero function | Explicit Xero API/SDK/secured bridge invocation | Plain `LambdaClient.Invoke` targets AWS Lambda only |

**SQS is the first AWS-origin event adapter** because it permits pull-based on-premises execution without inbound exposure. Other connections are separate, opt-in adapters. No automatic modification of existing triggers.

### 12.3 Function-to-function interoperability

- **Xero local -> native Lambda:** official Lambda Invoke API or SDK.
- **Native Lambda -> Xero local:** Xero's authenticated API/bridge reachable over approved networking, or asynchronous queue/event bridge.
- **Xero function -> Xero function:** stable logical identifiers through Xero SDK/API, regardless of placement.
- **Native Lambda -> native Lambda:** standard AWS SDK remains unchanged.
- **AWS-managed service -> hybrid function:** event source must be configured to target an explicit bridge/ingress if it is to reach local compute; native AWS Lambda triggers cannot be transparently rebound to Xero without reconfiguration.

Never promise drop-in redirection of existing `Invoke(FunctionName=AWS_ARN)` calls to local functions. That would require changing the calling integration, a gateway/proxy contract, or an explicit client adapter.

### 12.4 AWS identity and credential boundary

- Prefer short-lived credentials and least-privilege IAM scoped to the individual function/operation.
- Support standard local development AWS profiles and supported credential-provider chains without ever copying credentials into container images.
- For long-running on-premises workloads, design for **IAM Roles Anywhere** or a configured OIDC/STS federation solution; credentials must refresh and expire safely.
- Never expose controller-wide administrative permissions to arbitrary function code.
- Separate read-only AWS discovery, native Lambda invocation, AWS event polling, and future infrastructure deployment permissions.
- Document role trust policy, allowed resources, network endpoints, certificate rotation/revocation where applicable, and cost impact.
- Do not store raw secrets in logs, artifacts, manifests, screenshots, or state dumps.

### 12.5 Routing, consistency, and failure semantics

A policy must specify target eligibility, default target, runtime/version compatibility, resource constraints, permitted regions/accounts, and failure handling.

- Manual `local` / `aws-lambda` selection is the v0.1 baseline.
- Later weighted routing must operate at the **Xero gateway** and not pretend to be AWS Lambda alias weighted routing.
- Capacity overflow is an explicit routing decision; AWS charges, startup latency, and data residency must be visible.
- Network failure after dispatch can produce an **unknown execution outcome**. Do not automatically retry with side effects on another target.
- Queue/event delivery may be at least once. Document idempotency keys and transactional side-effect guidance.
- Target versions/configs may diverge. Define traffic pinning, deployment parity checks, and rollout/rollback semantics.
- Use trace propagation and a common invocation/correlation identifier; distinguish AWS CloudWatch native logs from Xero local logs.

### 12.6 AWS provisioning policy

- Existing AWS resources can be referenced using a read-only discovery/binding flow.
- Any new IAM role, SQS queue, Lambda function, EventBridge connection, API integration, or network bridge requires an explicit operator-approved plan showing region/account, resources, permissions, and teardown.
- No hidden paid AWS resource creation or trigger rewiring.
- Later native Lambda deployment should use an explicit AWS provider/adapter and immutable artifact/qualified version semantics.

### 12.7 Official technical references

- IAM Roles Anywhere: https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html
- Non-AWS workload credentials: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_non-aws.html
- Native Lambda weighted aliases: https://docs.aws.amazon.com/lambda/latest/dg/configuring-alias-routing.html
- EventBridge connections/API destinations: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-target-connection.html
- Step Functions HTTP Task: https://docs.aws.amazon.com/step-functions/latest/dg/call-https-apis.html
- API Gateway HTTP private integrations: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html
- SQS event source integration: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html

## 13. CLI, API, SDK, and future UI

### CLI

The CLI parses input, validates flags, renders results, and calls the SDK/controller. It must not directly implement function scheduling, container lifecycle, or persistence rules.

### API

Keep deployment/management operations separate from function invocation. Define stable response/error schemas. Bind locally by default; require deliberate configuration, transport protection, and authentication for remote exposure.

### SDK

Publish a small typed interface that can be embedded in other OSS or commercial tools without running a sponsor-hosted service.

### Web UI

Not required for v0.1. If added, it is an optional frontend over the same API—not a separate control plane or cloud-hosted user-account product.

## 14. Security requirements

Treat function artifacts as **untrusted executable code** and AWS accounts as sensitive external environments.

### Local execution

- Run untrusted functions in constrained, non-privileged containers with appropriate CPU/memory/pid limits.
- Do not mount Docker socket, controller state, host secret paths, user home directories, or privileged host interfaces into workers.
- Standard containers are **not a sufficient isolation boundary for hostile public multitenancy**; exclude that model from the MVP.
- Validate archives, artifact size, symlink/path traversal, resource limits, and dependency provenance.
- Do not expose controller/worker endpoints externally by default; require explicit secure configuration for remote use.
- Protect metadata and secrets at rest; redact errors and telemetry by default.

### AWS integration

- Keep AWS credential resolution and secret delivery in dedicated identity components with auditability and rotation.
- Do not inject controller-admin credentials into functions. Never use static access keys as the default or store them in artifacts.
- Ensure per-function IAM permissions can be scoped tightly; AWS endpoint access does not imply AWS resource authorization.
- Use TLS/mTLS or another documented strong transport and authentication for AWS-to-local bridges.
- Use outbound-only SQS polling as the default on-premises event ingress; do not create unsolicited public tunnels.
- Restrict allowed AWS accounts, regions, target ARNs, queues, and outbound endpoints according to policy. Avoid SSRF from untrusted configuration.
- Track event replay, duplicate delivery, signature/auth validation, request size limits, rate limiting, and denial-of-service risks.
- Make AWS resource mutations, trigger modifications, and costs visible and auditable.

Security documentation must threat-model local controller compromise, malicious function code, dependency attacks, token theft, leaked Roles Anywhere certificates, overly broad trust/IAM policies, replayed SQS messages, event bridge impersonation, remote-node compromise, accidental AWS charges, and unsafe egress/network exposure.

## 15. Tech choices and coding standards

### Baseline

- **Control plane and CLI:** TypeScript, Node.js LTS, strict type checking.
- **Repository:** `pnpm` workspace unless an ADR changes it.
- **Runtime adapters:** Node.js and Python, implemented in the language/runtime most suitable for faithful execution.
- **Local execution:** Docker-compatible container engine through a replaceable backend.
- **Metadata:** an embedded local store for MVP, with durable schema migrations.
- **Tests:** unit + integration + containerized end-to-end tests.

Do not force every execution worker to be implemented in TypeScript merely because the controller is TypeScript.

### Code quality

- Keep modules small with explicit ownership and typed interfaces.
- Avoid `any`, implicit global state, unhandled promises, and broad catch-and-ignore logic.
- Validate external input at API boundaries.
- Use structured errors with stable codes, not fragile string matching.
- Make time, process execution, filesystem paths, and network operations injectable/testable.
- Keep logs structured, useful, and redacted.
- Avoid premature abstraction: create extension points for known boundaries, not speculative vendors.
- Keep code and docs consistent with actual behavior.

## 16. Testing and definition of done

Every behavioral feature requires tests at the appropriate layer.

### Required test categories

**Runtime:** function schema; handlers in supported Node.js/Python versions; success/errors; malformed payloads; timeouts; cold/warm execution; idle scale-to-zero; concurrency and resource bounds; worker crashes; state recovery; logging/redaction; CLI-to-controller E2E.

**Hybrid/AWS:**

- Logical function registry with both local and AWS-target versions; static routing correctness.
- Native Lambda Invoke request formation, signer/region/qualifier, `InvocationType`, API errors, function errors, throttling, and denied permissions.
- SDK credential resolution, expiry/refresh, least-privilege tests, and secret redaction.
- Local handler calling an AWS SDK against an appropriate mock/test service endpoint.
- SQS poller processing, successful delete/acknowledge, failures/visibility expiry, duplicate delivery, backpressure, poison messages, and DLQ cases.
- Invocation trace/correlation across target boundaries, AWS outage behavior, and unknown-outcome classification.
- Explicit checks that local-only functions work without AWS credentials or network access.
- Conformance fixtures executed locally and against disposable native AWS Lambda deployments where practical, documenting intentional differences.

### Test execution policy

- The **default CI test suite** must require no real AWS credentials and must not incur cloud charges.
- Real AWS integration/conformance tests are opt-in and run only in a disposable isolated test account with bounded cost/permissions and guaranteed cleanup checks.
- Never use a developer's production AWS account automatically.
- Run only scripts actually defined in the repository. Never say checks passed unless they ran; report what could not be verified.

A change is done when code, tests, docs, compatibility claims, and security behavior agree.

## 17. Documentation is the source of truth

`CLAUDE.md` guides agents. Versioned product/architecture/security documentation and ADRs are the source of truth.

```text
docs/
├── product/
│   ├── vision.md
│   ├── principles.md
│   └── mvp.md
├── architecture/
│   ├── overview.md
│   ├── function-spec.md
│   ├── runtime-compatibility.md
│   ├── logical-functions-and-deployments.md
│   ├── hybrid-routing.md
│   ├── execution.md
│   ├── scheduling-scaling.md
│   ├── persistence.md
│   └── api-sdk.md
├── integrations/aws/
│   ├── credentials-and-iam.md
│   ├── native-lambda-invoke.md
│   ├── aws-service-access.md
│   ├── sqs-event-source.md
│   ├── inbound-bridges.md
│   └── interoperability-matrix.md
├── security/
│   └── threat-model.md
├── adr/
├── rfcs/
└── roadmap.md
```

Root: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and community/governance documents as appropriate. Choose a permissive license intentionally, and check dependency compatibility before publication.

ADRs are required for function identity, routing boundaries, AWS identity/permission model, artifact parity, event delivery semantics, execution isolation, state storage, remote ingress, and future multi-node coordination.

Use RFCs for backward-incompatible contracts, mandatory external infrastructure, or new categories of AWS event integrations. **Integrating an existing AWS service is not implementing that service as part of Xero.**

## 18. Claude Code operating instructions

Before modifying this repository:

1. Read `README.md`, `docs/product/mvp.md`, relevant architecture/integration docs, and approved ADRs.
2. Inspect actual code, commands, packages, tests, and resources; do not invent working capabilities.
3. Identify whether the request touches local execution, logical routing, AWS target invocation, identity, or event ingress.
4. State the smallest vertical slice that fulfills the requirement and which packages it affects.
5. Confirm it keeps the product functions-only and preserves local-only usability.
6. Implement behind the correct domain/provider/transport boundary with explicit error contracts.
7. Include permission/security checks, test coverage, and documentation for new AWS integrations.
8. Run actual lint/typecheck/tests/build; report outcomes accurately.
9. Summarize changed behavior, target semantics, limitations, AWS permission/cost effects, and deferred work.

### Mandatory rules for agents

- **Do** treat AWS interoperability as a core requirement rather than leaving it entirely for later.
- **Do** preserve one logical function identity that can refer to independent local/AWS deployments.
- **Do** support existing native Lambda bindings without requiring Xero to have created the Lambda.
- **Do** preserve local-only installations without AWS credentials.
- **Do** explicitly identify when a feature relies on an API/queue/bridge instead of a native AWS Lambda trigger.
- **Do not** present local workers as native AWS Lambda instances or Xero routing as Lambda alias behavior.
- **Do not** promise transparent interception of AWS Lambda ARNs or AWS SDK Invoke calls.
- **Do not** silently split a single invocation between environments or duplicate non-idempotent work on fallback.
- **Do not** recreate S3/DynamoDB/SQS/EventBridge or turn Xero into a cloud clone.
- **Do not** make Kubernetes or a sponsor account mandatory.
- **Do not** share controller-admin credentials with function workers or use long-lived keys by default.
- **Do not** automatically create chargeable AWS resources, modify source mappings, or expose host ports.
- **Do not** invent implemented commands or claim unverified parity.
- **Do not** put business logic in CLI/HTTP handlers, or add AI to critical dispatch.
- **Do** document AWS service-specific constraints and maintain conformance tests.

### Decision order

1. User/security/data protection and explicit consent for AWS changes.
2. Current product scope: functions only, local-first, hybrid AWS interoperability.
3. Approved architectural decisions and versioned documentation.
4. Stable published API semantics.
5. Reliability, maintainability, and simplicity.
6. Performance and extensibility.

When a request conflicts with a native AWS technical limitation, explain the limitation and implement an explicit supported adapter/bridge rather than fabricating native behavior.

## 19. Development roadmap

### Phase 0 — Contracts and threat model

- Document product principles, function spec, logical ID vs deployment ID, and target interfaces.
- Define AWS credential/permission boundaries, SQS delivery semantics, and explicit routing policy.
- Add initial ADRs, interoperability matrix, and no-AWS local install requirements.

### Phase 1 — Reliable local function engine

- Local Node.js handler, CLI -> controller -> container -> handler -> response.
- Python adapter, immutable artifacts, logs, safe limits, persistence, cold/warm lifecycle.
- Real local E2E testing.

### Phase 2 — AWS-connected execution

- AWS identity adapter, safe temporary credential delivery, SDK integration guidance.
- Existing native AWS Lambda target binding and actual Invoke API adapter.
- Registry for one logical function with local + AWS deployments; explicit target choice.
- Hybrid contract tests, mock AWS test environment, and optional disposable-account tests.

### Phase 3 — AWS-to-local ingress and v0.1 release

- Opt-in SQS event source consumer with reliable acknowledgment, visibility, retries, and DLQ behavior.
- Demonstrate local AWS-service SDK access and native Lambda invocation with explicit permissions.
- Complete security review, compatibility matrix, docs, install guides, and v0.1 acceptance suite.

### Phase 4 — Advanced hybrid routing

- Define and implement weighted routing, health/capacity-aware spillover, and opt-in failover with idempotency safeguards.
- Add optional native Lambda deployment/synchronization adapter with explicit approval.
- Add additional AWS-origin ingress patterns (EventBridge HTTPS destination, API Gateway, Step Functions).

### Phase 5 — Distributed function fabric

- Multi-node join/leave, leases, artifact distribution, placement, and reconciliation.
- Optional K3s/Kubernetes backend where it materially helps, without making it mandatory.
- Add AWS-hosted Xero nodes as separate deployment targets and resilient control-plane options.

### Phase 6 — Production hybrid maturity

- Policy-driven cost/latency/data-locality placement, coordinated releases, tracing, and robust rollback.
- Expanded event connector catalog and proven conformance for additional runtimes.

Do not attempt Phase 4–6 functionality before the v0.1 integration contract is correct and testable.

## 20. Acceptance criteria for v0.1

A new user must be able to:

1. Install and run Xero locally with **no AWS account** or Cloud Republic account.
2. Deploy, invoke, inspect logs, update, and remove Node.js and Python Lambda-style handlers.
3. Configure and verify bounded concurrency, timeouts, memory limits, cold starts, warm reuse, and scale-to-zero.
4. Restart Xero without losing local function/target metadata.
5. Connect an **existing AWS account** using a supported, operator-chosen credential provider and region.
6. Execute a local function that calls a **real AWS service** via its official SDK with suitable temporary permissions.
7. Bind an **existing AWS Lambda** ARN/alias to a logical Xero function and invoke it through Xero without requiring Xero to own that Lambda deployment.
8. Bind both local and AWS Lambda deployments to **one Xero logical function**, and explicitly run an invocation on either target.
9. Attach a pre-existing **SQS queue** as an opt-in AWS-origin event source and process messages locally with documented at-least-once behavior.
10. Inspect which deployment handled an invocation, observe useful failures, and correlate logs where supported.
11. Keep local-only workloads running during an AWS connectivity outage if they do not depend on AWS.
12. Run the default test suite without cloud credentials or charges; use a separate opt-in AWS conformance/integration suite.
13. Use the same core capabilities through CLI/API/SDK with no hosted proprietary dependency.

**Not required in v0.1:** auto deployment of native Lambda, weighted hybrid balancing, multi-node clusters, autonomous cloud bursting, or transparent rewiring of existing AWS-managed triggers.

## 21. Final instruction

**Build Xero as an open-source, Lambda-compatible hybrid compute fabric that works locally yet feels naturally connected to AWS.**

One logical function. Independent local and AWS Lambda deployments. One explicit invocation/router contract. Real AWS services through real AWS SDKs. Secure AWS-origin event adapters. Honest execution semantics.

Start small and prove the entire hybrid path before scaling outward:

`Local handler → AWS SDK → existing AWS Lambda → logical dual-target routing → SQS-triggered local handler`.

Then introduce weighted routing, additional AWS event integrations, multiple Xero nodes, and capacity-based spillover. Keep the engine independently useful and never claim Xero can transform a local computer into a native AWS Lambda worker.

