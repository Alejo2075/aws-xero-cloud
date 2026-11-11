# AGENTS.md

Agent instructions live in [`CLAUDE.md`](CLAUDE.md). Essentials:

- Functions only; local-first; AWS interoperability is opt-in but a core contract.
- Never create chargeable AWS resources, never use real AWS credentials in default tests.
- Run only scripts that exist in `package.json`; report outcomes honestly.
