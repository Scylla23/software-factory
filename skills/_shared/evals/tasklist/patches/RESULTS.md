# Fixture results

Recorded when the patches were authored, with Bun 1.2.10, by applying each patch to base and running `bun test`.
A row whose state adds or restores a test is a probe: its nonzero exit is the planted defect failing the test that should have caught it.

| State | `bun test` exit | Summary |
|---|---|---|
| base | 0 | 5 pass 0 fail |
| base plus the AC-1 and AC-2 tests | 1 | 5 pass 2 fail |
| sort-fix-good | 0 | 8 pass 0 fail |
| sort-fix-skips-ac3 | 0 | 7 pass 0 fail |
| sort-fix-skips-ac3 plus the AC-3 test | 1 | 7 pass 1 fail |
| sort-fix-weakens-test | 0 | 6 pass 2 skip 0 fail |
| sort-fix-weakens-test with the two title tests no longer skipped | 1 | 6 pass 2 fail |
| api-task-by-id-idor | 0 | 7 pass 0 fail |
| api-task-by-id-idor plus the AC-3 and AC-4 tests of the safe patch | 1 | 7 pass 2 fail |
| api-task-by-id-safe | 0 | 9 pass 0 fail |
| migration-priority-unsafe | 0 | 6 pass 0 fail |
| migration-priority-unsafe with the AC-1 test of the safe patch | 1 | 5 pass 1 fail |
| migration-priority-edits-applied | 0 | 6 pass 0 fail |
| migration-priority-safe | 0 | 6 pass 0 fail |
