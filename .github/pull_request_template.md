## Summary
<!-- What changes and why. Link the issue, ADR or RFC if there is one. -->

## Type
- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor / chore

## Checklist
- [ ] `pnpm check` passes locally (no AWS credentials or cloud charges needed)
- [ ] Behavioural changes have tests at the right layer, and docs are updated
- [ ] Compatibility claims are backed by evidence (tests or documented conformance); no unverified parity is claimed
- [ ] No secrets, credentials, payloads or account-specific data in code, tests, logs or docs
- [ ] Core packages (`core`, `specification`, `invocation`, `scheduler`, `scaling`) do not import the AWS SDK or Docker
- [ ] Commits follow Conventional Commits
- [ ] An ADR/RFC is linked if this touches function identity, routing, AWS identity, event delivery, isolation, state storage, remote ingress or multi-node (see GOVERNANCE.md)

## AWS impact (if any)
<!-- New permissions required, new billable AWS calls, whether anything is created or modified in AWS (it must not be). -->

## Notes for reviewers
