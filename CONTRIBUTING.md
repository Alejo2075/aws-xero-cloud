# Contributing

1. Read `CLAUDE.md`, `docs/product/mvp.md` and the relevant ADRs before changing behaviour.
2. Keep the product **functions-only** and **local-first**; AWS is always opt-in.
3. Every behavioural change needs tests at the right layer and updated docs. Compatibility claims need evidence.
4. `pnpm check` must pass without AWS credentials. Real-AWS tests are opt-in and only for disposable accounts.
5. Commits follow Conventional Commits (`feat(registry): ...`). Backward-incompatible contracts need an RFC; the
   topics listed in `CLAUDE.md` §17 need an ADR.
6. Dependency rules (enforced by ESLint): `core`, `specification`, `invocation`, `scheduler`, `scaling` never import
   AWS SDK, Docker, or Kubernetes. AWS SDK code lives only in `aws-identity`, `target-aws-lambda`, `event-source-sqs`
   and the AWS wiring of the controller.
