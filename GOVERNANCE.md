# Governance

Xero is an independent open-source project stewarded by Cloud Republic. This document describes how decisions are made. It is
deliberately lightweight and will be revised through the process below as the community grows.

## Principles

- **Independent and self-hostable.** Xero must stay useful without any Cloud Republic, Hero or Zerverless service, a hosted
  control plane, an account, or an AI service. Sponsorship is never a runtime dependency, and sponsors have no control over
  technical decisions.
- **Product scope is a decision, not a drift.** Xero provides function compute only. It does not become a cloud service
  catalogue, a PaaS, or a clone of AWS services. Local-first operation and opt-in AWS interoperability are core contracts.
- **Decisions are written down.** The source of truth is versioned documentation, not chat history or agent instructions.

## Roles

- **Users and contributors** — anyone who opens issues, discussions, pull requests, reviews or documentation. Everyone is
  bound by the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Maintainers** — people with merge rights who steward the project. Maintainers are named in the repository settings (and in a
  `MAINTAINERS` file once there is more than one). A contributor becomes a maintainer by invitation after a sustained record of
  quality contributions and reviews, agreed by consensus of the existing maintainers. A maintainer who is inactive for 6
  months, or who steps down, moves to emeritus status.
- **Stewards (Cloud Republic)** — hold the repository, trademarks and release credentials in trust for the project. They do not
  override the documented scope and decision process below.

## How decisions are made

1. **Everyday changes** (bug fixes, tests, docs, refactors that keep behaviour): a pull request with at least one maintainer
   approval and passing checks (`pnpm check`). Lazy consensus applies: if no maintainer objects within a reasonable review
   window, the change can merge.
2. **Architectural decisions** require an **ADR** in [`docs/adr/`](docs/adr): function identity, routing boundaries, AWS
   identity and permission model, artifact parity, event delivery semantics, execution isolation, state storage, remote
   ingress, and multi-node coordination.
3. **RFCs** in [`docs/rfcs/`](docs/rfcs) are required for backward-incompatible contracts (API, SDK, function spec), anything
   that makes external infrastructure mandatory, and every new category of AWS event integration. An RFC has a comment period
   of at least 7 days before acceptance.
4. **Scope changes.** Features deferred in [`docs/product/mvp.md`](docs/product/mvp.md) are not implemented until that file is
   changed through an approved ADR. Anything outside "functions only" requires an explicit scope decision recorded in an ADR.
5. **Consensus first.** Maintainers seek consensus. If it cannot be reached, a decision needs approval from a majority of active
   maintainers; with two maintainers, both must agree. Conflicts of interest must be disclosed, and the person concerned
   abstains.
6. **Safety overrides speed.** Decisions are weighed in this order: user safety, security and data protection, and explicit consent
   for any AWS change; then product scope; then approved decisions and documentation; then stable API semantics; then
   reliability and simplicity; then performance and extensibility.

## Project rules that cannot be waived by a single decision

- Xero never creates chargeable AWS resources, rewires triggers, or switches traffic without an explicit, operator-approved plan.
- Compatibility claims need evidence (tests or documented conformance results). Do not claim parity that has not been tested.
- Default test suites need no real AWS credentials and incur no cloud charges; real-AWS tests are opt-in and disposable-account only.
- Credentials and secrets never appear in logs, artifacts, manifests or state dumps.

## Security

Vulnerabilities are handled privately as described in [`SECURITY.md`](SECURITY.md). Security fixes may be developed and released
without the usual public review window; the rationale is published afterwards.

## Releases

Releases follow semantic versioning once the API leaves `v1alpha1`. A release requires a green `pnpm check`, an updated
[`CHANGELOG.md`](CHANGELOG.md) with a list of known limitations, and at least one maintainer approval. Publishing to package
registries stays disabled until the project name is decided.

## Name, trademarks and license

- Code is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license (inbound = outbound).
- "Xero" is a **working name**. Adopting a definitive name, domain or registry scope is a governance decision recorded in an ADR
  and requires a trademark check first.
- AWS and AWS Lambda are trademarks of Amazon.com, Inc. Xero is not affiliated with or endorsed by AWS.

## Changing this document

Changes to governance are proposed by pull request, discussed for at least 7 days, and need approval from a majority of active
maintainers.
