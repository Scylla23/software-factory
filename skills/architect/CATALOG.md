# Architecture catalog: preferred patterns and anti-patterns

Seeded defaults for the owner to edit.
Patterns are preferred approaches; anti-patterns are named when a tempting option is rejected.
Verified on 2026-11-19; method and results are in [catalog-verification.md](../_shared/catalog-verification.md).
This index is for people; agents and the factory read [catalog.json](catalog.json), which is the source of truth.

## Patterns

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `modular-monolith-first` | [Monolith first, with module boundaries](https://martinfowler.com/bliki/MonolithFirst.html) | structure | Default shape for every new project: one deployable, internal modules with explicit interfaces. | A hard constraint forces a separate deployable: a different runtime, isolation requirement, or scaling profile. |
| `vertical-slices` | [Vertical slices by feature](https://www.jimmybogard.com/vertical-slice-architecture/) | structure | Organizing application code so one feature's route, logic, data access, and tests live together. | Shared infrastructure code (database client, auth, logging), which belongs in its own module. |
| `functional-core-imperative-shell` | [Functional core, imperative shell](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell) | structure | Business rules that deserve fast, exhaustive tests: keep decisions pure and push I/O to a thin shell. | Code that is almost all I/O glue; forcing a pure core there adds ceremony without tests worth having. |
| `parse-dont-validate` | [Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) | boundaries | Every trust boundary: turn untrusted input into a typed value once, and pass only the typed value inward. | Never at a trust boundary. Inside the core, do not re-check what the type already guarantees. |
| `ports-and-adapters` | [Ports and adapters at external boundaries](https://alistair.cockburn.us/hexagonal-architecture/) | boundaries | Each external service (payments, email, model providers): a small interface the app owns, a real adapter, and a fake for tests and the preview. | Internal modules and the project's own database; an interface with one implementation and no fake is speculative. |
| `expand-contract-migrations` | [Expand and contract (parallel change)](https://martinfowler.com/bliki/ParallelChange.html) | data | Any change to a schema or interface that live code or stored data depends on: add the new shape, migrate, then remove the old shape in a later release. | A brand-new table or interface with no consumers and no data yet. |
| `transactional-outbox` | [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) | reliability | A database change must reliably trigger an external effect (email, webhook, queue message). | The effect is safe to lose or to run inside the request; do not add an outbox for best-effort notifications. |
| `idempotency-keys` | [Idempotency keys for retried effects](https://brandur.org/idempotency-keys) | reliability | Any operation a client, queue, or webhook may deliver more than once and that must take effect once. | Naturally idempotent operations such as setting a field to a value. |
| `twelve-factor-config` | [Config in the environment](https://12factor.net/config) | config | Everything that differs between local, preview, and production, and every secret. | Constants that never vary by deploy; keep those in code. |
| `strangler-fig` | [Strangler fig replacement](https://martinfowler.com/bliki/StranglerFigApplication.html) | evolution | Replacing a subsystem in an existing project: route slices to the new implementation one at a time behind a stable interface. | Small modules that can be replaced in one reviewed change. |
| `choose-boring-technology` | [Choose boring technology](https://mcfunley.com/choose-boring-technology) | technology-choice | Every technology pick: prefer what the project and the catalog already use, and justify each new moving part. | Never; a new technology is allowed, but only with a stated reason the boring option cannot meet. |

## Anti-patterns

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `microservices-first` | [Microservices first](https://martinfowler.com/bliki/MicroservicePremium.html) | structure | Cite when a design splits a new or small system into separately deployed services. | The split is forced by a real constraint, which the decision must name. |
| `speculative-generality` | [Building for imagined futures (YAGNI)](https://martinfowler.com/bliki/Yagni.html) | structure | Cite when a design adds extension points, config, or abstractions no acceptance criterion needs. | The capability is required by a criterion in this task. |
| `wrong-abstraction` | [The wrong abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) | structure | Cite when a design merges code paths that only look alike, or keeps bending a shared helper with flags. | The cases share one reason to change. |
| `dual-writes` | [Dual writes without atomicity](https://www.confluent.io/blog/dual-write-problem/) | data | Cite when code writes to the database and to another system in sequence and assumes both succeed. | The second write is best-effort by design and its loss is acceptable and stated. |
