# Step 4b batch 2 measurements

The 32 Claude sessions consumed $17.92743 of the $25 API-equivalent budget.
All 63 contestant and grading sessions together cost $27.35498 at API-equivalent rates.
The batch used low effort for Sonnet judges and high effort for contestants and Codex judges.
The persisted stop prevented further Claude launches at `owner handover: no new sessions`.

## Case rates

Rates count fresh batch 2 contestants and exclude unresolved trials from the graded denominator.
The earlier solo lead passed 12/12 on offline rescore and retains its original 11/12 in the batch 1 record.

| Case and variant | Passed / graded | Fresh trials required | Pending judgment | Unstarted | Reason |
| --- | ---: | ---: | ---: | ---: | --- |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 1/2 | 2 | 0 | 0 |  |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 3/3 | 3 | 0 | 0 |  |
| spec-lead-02-tier-promotion-runs-team | 0/3 | 3 | 0 | 0 |  |
| spec-lead-03-ac-changing-conflict-escalates | 0/3 | 3 | 0 | 0 |  |
| spec-reviewer-01-planted-defects/four-defects | none | 3 | 3 | 0 |  |
| spec-reviewer-01-planted-defects/requirement-moved-to-non-goals | none | 3 | 3 | 0 |  |
| spec-reviewer-02-clean-spec-approves/bug-spec | none | 3 | 3 | 0 |  |
| spec-reviewer-02-clean-spec-approves/plan-creates-a-file | 0/3 | 3 | 0 | 0 |  |
| spec-reviewer-03-revision-breaks-something-else | none | 3 | 3 | 0 |  |
| security-auditor-01-cross-user-access-in-diff | none | 3 | 0 | 3 | R3 |
| security-auditor-02-safe-diff-approves | none | 3 | 0 | 3 | R3 |
| security-auditor-03-spec-stage/revision-edits-only-the-threat-model | none | 3 | 3 | 0 |  |
| code-reviewer-01-good-fix-approves | none | 3 | 0 | 3 | R3 |
| code-reviewer-02-untested-unmet-criterion | none | 3 | 0 | 3 | R3 |
| code-reviewer-03-test-integrity/undeclared-skip | none | 3 | 0 | 3 | R3 |
| code-reviewer-03-test-integrity/declared-deletion | none | 3 | 0 | 3 | R3 |
| database-auditor-01-unsafe-migration | none | 3 | 0 | 3 | R3 |
| database-auditor-02-safe-migration-approves | none | 3 | 0 | 3 | R3 |
| database-auditor-03-edited-applied-migration | none | 3 | 0 | 3 | R3 |
| architect-01-new-project | 2/3 | 3 | 0 | 0 |  |
| architect-02-split-temptation | 3/3 | 3 | 0 | 0 |  |
| architect-03-existing-project-delta | 0/2 | 3 | 1 | 0 |  |
| infra-01-new-project | none | 3 | 0 | 3 | owner handover |
| infra-02-catalog-gap | none | 3 | 0 | 3 | owner handover |
| infra-03-existing-project-wins | none | 3 | 0 | 3 | owner handover |
| frontend-01-new-project | none | 3 | 0 | 3 | owner handover |
| frontend-02-palette-and-ai-surface | none | 3 | 0 | 3 | owner handover |
| frontend-03-gap-not-substitute | none | 3 | 0 | 3 | owner handover |
| threat-modeler-01-per-user-data | none | 3 | 0 | 3 | owner handover |
| threat-modeler-02-mitigation-changes-criteria | none | 3 | 0 | 3 | owner handover |
| threat-modeler-03-small-flagged-task | none | 3 | 0 | 3 | owner handover |
| verifier-01-plan-by-tag | none | 3 | 0 | 3 | owner handover |
| verifier-02-judge-test-evidence/missing-and-contrary-evidence | none | 3 | 0 | 3 | owner handover |
| verifier-02-judge-test-evidence/stale-evidence | none | 3 | 0 | 3 | owner handover |
| verifier-02-judge-test-evidence/base-fails-for-the-wrong-reason | none | 3 | 0 | 3 | owner handover |
| verifier-02-judge-test-evidence/sound-evidence | none | 3 | 0 | 3 | owner handover |
| verifier-03-judge-ui-capture | none | 3 | 0 | 3 | owner handover |

## Batch 1 submissions judged in batch 2

The combined rates include batch 1 deterministic failures and the frozen submissions judged in this batch.

| Case and variant | Combined pass rate |
| --- | ---: |
| builder-01-bug-reproduce-first | 2/3 |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 3/3 |
| builder-02-security-criteria | 3/3 |
| builder-03-repair-fix-and-dispute | 3/3 |

| Case | Trial | Contestant session | Result |
| --- | ---: | --- | --- |
| builder-01-bug-reproduce-first | 1 | 01a1f75a-1b04-7310-9788-81a557e7b599 | pass |
| builder-01-bug-reproduce-first | 2 | 01a1f75c-3501-7de0-ae6f-5b0fd3f42a42 | pass |
| builder-02-security-criteria | 1 | 01a1f75e-d164-75f1-baaf-d3ecc4bc60ef | pass |
| builder-02-security-criteria | 2 | 01a1f760-e84f-7600-9781-97d5665e1285 | pass |
| builder-02-security-criteria | 3 | 01a1f768-c9af-7e82-bc7a-f06329829c2c | pass |
| builder-03-repair-fix-and-dispute | 1 | 01a1f76b-2fed-73e3-be9d-5485689e5413 | pass |
| builder-03-repair-fix-and-dispute | 2 | 01a1f76d-4b55-7731-9655-94d2f1e89240 | pass |
| builder-03-repair-fix-and-dispute | 3 | 01a1f76f-74af-7041-8387-1cf8c782b137 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 1 | 01a1f771-2bee-7383-8dac-357c892a9a32 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 2 | 01a1f771-fb31-7412-adbe-c6ec0da674f3 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 3 | 01a1f772-c9fc-7a62-a171-f5802f6dc09c | pass |

## Sessions

| Case and variant | Trial | Role | Model | Session | Fresh | Cache read | Cache write | Output | USD | Result |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| builder-01-bug-reproduce-first | 1 | Sonnet judge | claude-sonnet-5-5 | b48aa696-30e7-4717-b49a-6610dc824667 | 2 | 649 | 9607 | 568 | 0.04418 | pass |
| builder-01-bug-reproduce-first | 2 | Sonnet judge | claude-sonnet-5-5 | 91380598-d75b-43e6-bd56-636508673aab | 2 | 1635 | 8829 | 585 | 0.04133 | pass |
| builder-02-security-criteria | 1 | Sonnet judge | claude-sonnet-5-5 | 4c214c93-05cc-4d7b-acf6-d1df4d934628 | 2 | 1635 | 11098 | 148 | 0.04604 | pass |
| builder-02-security-criteria | 2 | Sonnet judge | claude-sonnet-5-5 | 114a9d7e-d11f-4358-8726-36811a84e8c7 | 2 | 1635 | 10974 | 558 | 0.04964 | pass |
| builder-02-security-criteria | 3 | Sonnet judge | claude-sonnet-5-5 | 7047414b-612d-446b-b83a-c513041df1ff | 2 | 1635 | 10796 | 542 | 0.04877 | pass |
| builder-03-repair-fix-and-dispute | 1 | Sonnet judge | claude-sonnet-5-5 | 85c449c8-c236-4ce0-8d56-f0f9d161c9ee | 2 | 1635 | 11779 | 171 | 0.04899 | pass |
| builder-03-repair-fix-and-dispute | 2 | Sonnet judge | claude-sonnet-5-5 | d02801f1-a432-4413-8b5b-1af5f631f2e4 | 2 | 1635 | 11710 | 247 | 0.04948 | pass |
| builder-03-repair-fix-and-dispute | 3 | Sonnet judge | claude-sonnet-5-5 | 1d9f4036-48b0-4891-8d5a-5e64886136eb | 2 | 1635 | 11724 | 267 | 0.04973 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 1 | Sonnet judge | claude-sonnet-5-5 | f028380a-13e3-4fb5-8e98-89a0006eb5c1 | 2 | 1635 | 7617 | 243 | 0.03307 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 2 | Sonnet judge | claude-sonnet-5-5 | f419b529-7ddc-489d-81e3-1685f1a52247 | 2 | 1635 | 7568 | 231 | 0.03275 | pass |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 3 | Sonnet judge | claude-sonnet-5-5 | 8dfa38bd-1381-4317-893e-fb918bedb92a | 2 | 1635 | 7584 | 232 | 0.03282 | pass |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 2 | spec-lead | claude-opus-5-5 | 8d50e2c3-bdb8-4d3a-be6f-8f14a97f1a43 | 16 | 218579 | 32723 | 13947 | 0.58450 | pass |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 3 | spec-lead | claude-opus-5-5 | 0eccfcfd-46f2-4e57-8083-172490bf9d4d | 14 | 165424 | 27163 | 9338 | 0.43720 | fail - observable |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 1 | spec-lead | claude-opus-5-5 | 6a7847f0-2990-442b-9c19-b665a27019be | 14 | 162602 | 36283 | 8792 | 0.49868 | pass |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 2 | spec-lead | claude-opus-5-5 | f2026d6d-ac46-4ad5-8daa-4599338beccf | 12 | 140960 | 25661 | 7015 | 0.37383 | pass |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 3 | spec-lead | claude-opus-5-5 | 19f2d3b2-ea28-454a-b609-33c6fc32af07 | 14 | 185524 | 30929 | 9714 | 0.47887 | pass |
| spec-lead-02-tier-promotion-runs-team | 1 | spec-lead | claude-opus-5-5 | 36f01f7c-8483-4b7f-aaeb-da88fe4cbb70 | 8 | 69390 | 16474 | 2516 | 0.19602 | team handoff |
| spec-lead-02-tier-promotion-runs-team | 1 | spec-team | claude-opus-5-5 | 23754a09-e027-4bf6-bf67-54f4d4fb7b52 | 88 | 1517781 | 235466 | 65760 | 2.49723 | fail - 3 result events; accounting is ambiguous |
| spec-lead-02-tier-promotion-runs-team | 2 | spec-lead | claude-opus-5-5 | 81abe8d0-d654-4a7b-8858-60a08586cc42 | 8 | 67600 | 12994 | 2161 | 0.16072 | fail - team handoff |
| spec-lead-02-tier-promotion-runs-team | 3 | spec-lead | claude-opus-5-5 | 4b01cb25-fc81-49ff-9a09-fe2b9ee8aa41 | 10 | 101839 | 20301 | 2774 | 0.23830 | fail - team handoff |
| spec-lead-03-ac-changing-conflict-escalates | 1 | spec-team | claude-opus-5-5 | d7a51438-bed7-4ba9-9581-06b852f98ffc | 80 | 1569147 | 226483 | 75468 | 2.68202 | fail - 3 result events; accounting is ambiguous |
| spec-lead-03-ac-changing-conflict-escalates | 2 | spec-team | claude-opus-5-5 | 76c0dcee-642a-43e3-8862-2228e045fd65 | 78 | 1430560 | 228058 | 80828 | 2.68268 | fail - 3 result events; accounting is ambiguous |
| spec-lead-03-ac-changing-conflict-escalates | 3 | spec-team | claude-opus-5-5 | 56b22c47-3d83-4f18-852b-743006a23327 | 84 | 1505985 | 246999 | 87273 | 2.84238 | fail - 3 result events; accounting is ambiguous |
| architect-01-new-project | 1 | architect | claude-opus-5-5 | c12d7e82-3904-4abe-9e65-4263205241c2 | 6 | 27696 | 26814 | 9686 | 0.41380 | pass |
| architect-01-new-project | 2 | architect | claude-opus-5-5 | c5c8d54a-9095-4785-8f1a-6c707578676d | 6 | 30538 | 24439 | 10142 | 0.40448 | fail - no-vendors |
| architect-01-new-project | 3 | architect | claude-opus-5-5 | 7f09298d-cda1-40ef-8346-fdab4e1e8667 | 6 | 30595 | 25438 | 11164 | 0.43293 | pass |
| architect-02-split-temptation | 1 | architect | claude-opus-5-5 | 0322da41-5743-4aa1-8638-067059543197 | 6 | 29991 | 20775 | 6958 | 0.31138 | pass |
| architect-02-split-temptation | 2 | architect | claude-opus-5-5 | 83d34f7f-1bdc-48c3-8e4d-f93cde4b426e | 8 | 48559 | 20862 | 6890 | 0.31444 | pass |
| architect-02-split-temptation | 3 | architect | claude-opus-5-5 | 3dacd20b-ade3-4e07-b5e8-ba84204b38c1 | 6 | 30237 | 22377 | 8470 | 0.35449 | pass |
| architect-03-existing-project-delta | 1 | architect | claude-opus-5-5 | 39637af0-e649-490e-acc3-e8eb1e1b8b0c | 12 | 114450 | 34946 | 14446 | 0.59143 | fail - cites-code |
| architect-03-existing-project-delta | 2 | architect | claude-opus-5-5 | 642a5c9b-f859-46e1-ae22-2c4d5ae62270 | 12 | 108188 | 30507 | 9759 | 0.46092 | fail - cites-code |
| architect-03-existing-project-delta | 3 | architect | claude-opus-5-5 | fd0649c7-6481-4fa9-b621-8c38389ec5c9 | 12 | 109298 | 31865 | 10875 | 0.49433 | unjudged |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 2 | Codex judge | gpt-6.2-astra | 01a1f786-d719-7421-8488-dd9d1851b658 | 7908 | 9472 | 0 | 694 | 0.09481 | pass |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 3 | Codex judge | gpt-6.2-astra | 01a1f788-8d0f-76a1-8226-dd7374c988c8 | 17401 | 0 | 0 | 322 | 0.15209 | fail - observable |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 1 | Codex judge | gpt-6.2-astra | 01a1f78a-0f5d-76d0-a665-84b54ea6794b | 8925 | 9472 | 0 | 424 | 0.09215 | pass |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 2 | Codex judge | gpt-6.2-astra | 01a1f78b-5441-7671-9090-d322ce9b122c | 8754 | 9472 | 0 | 509 | 0.09418 | pass |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 3 | Codex judge | gpt-6.2-astra | 01a1f78d-131b-7281-97c5-02aa4bb00d55 | 18632 | 0 | 0 | 374 | 0.16402 | pass |
| architect-01-new-project | 1 | Codex judge | gpt-6.2-astra | 01a1f7bf-300d-7f71-b0c1-856428eb47e3 | 5663 | 9472 | 0 | 165 | 0.05569 | pass |
| architect-01-new-project | 2 | Codex judge | gpt-6.2-astra | 01a1f7c1-11f0-7b71-ae45-d8ed51cda961 | 11496 | 4096 | 0 | 181 | 0.10085 | pass |
| architect-01-new-project | 3 | Codex judge | gpt-6.2-astra | 01a1f7c3-10cb-7123-b219-7f7ccfd70c32 | 6293 | 9472 | 0 | 209 | 0.06249 | pass |
| architect-02-split-temptation | 1 | Codex judge | gpt-6.2-astra | 01a1f7c4-6104-7c62-b87b-061a7a7ddf7a | 4960 | 9472 | 0 | 347 | 0.05735 | pass |
| architect-02-split-temptation | 2 | Codex judge | gpt-6.2-astra | 01a1f7c5-d093-7411-a0ac-c4d98c481706 | 14666 | 0 | 0 | 470 | 0.13613 | pass |
| architect-02-split-temptation | 3 | Codex judge | gpt-6.2-astra | 01a1f7c7-73a5-79d0-aa80-36861d3cdc2a | 5706 | 9472 | 0 | 253 | 0.05956 | pass |
| architect-03-existing-project-delta | 1 | Codex judge | gpt-6.2-astra | 01a1f7c9-bdd0-7511-8909-32ceef0741b9 | 8500 | 9472 | 0 | 296 | 0.08363 | pass |
| architect-03-existing-project-delta | 2 | Codex judge | gpt-6.2-astra | 01a1f7cb-7e5b-7020-adf7-b99811f503b2 | 8820 | 9472 | 0 | 283 | 0.08567 | pass |
| security-auditor-03-spec-stage/revision-edits-only-the-threat-model | 1 | security-auditor | gpt-6.2-astra | 01a1f780-ea0d-7ab1-9cc1-1fee0b5e54ab | 45176 | 147968 | 0 | 1746 | 0.49044 | unjudged |
| security-auditor-03-spec-stage/revision-edits-only-the-threat-model | 2 | security-auditor | gpt-6.2-astra | 01a1f781-bfcf-70c0-9695-31dd37ed0961 | 36488 | 159744 | 0 | 1943 | 0.43352 | unjudged |
| security-auditor-03-spec-stage/revision-edits-only-the-threat-model | 3 | security-auditor | gpt-6.2-astra | 01a1f782-c29a-7533-9a0d-9cc768fdde04 | 35047 | 199168 | 0 | 1961 | 0.43848 | unjudged |
| spec-reviewer-01-planted-defects/four-defects | 1 | spec-reviewer | gpt-6.2-astra | 01a1f784-b721-7911-bd06-9656cdf86774 | 34850 | 188544 | 0 | 3614 | 0.49878 | unjudged |
| spec-reviewer-01-planted-defects/four-defects | 2 | spec-reviewer | gpt-6.2-astra | 01a1f786-291f-7a70-9b9d-0d8f09a9dc9e | 37847 | 198400 | 0 | 3826 | 0.53518 | unjudged |
| spec-reviewer-01-planted-defects/four-defects | 3 | spec-reviewer | gpt-6.2-astra | 01a1f787-bbce-7de1-8b4f-8544f191a9d1 | 35457 | 193664 | 0 | 3650 | 0.50712 | unjudged |
| spec-reviewer-01-planted-defects/requirement-moved-to-non-goals | 1 | spec-reviewer | gpt-6.2-astra | 01a1f789-32d4-7f70-9406-26da1abd0056 | 34882 | 154752 | 0 | 2564 | 0.44352 | unjudged |
| spec-reviewer-01-planted-defects/requirement-moved-to-non-goals | 2 | spec-reviewer | gpt-6.2-astra | 01a1f78a-4f5e-7a91-87e3-234248b7a275 | 36142 | 156544 | 0 | 2526 | 0.45279 | unjudged |
| spec-reviewer-01-planted-defects/requirement-moved-to-non-goals | 3 | spec-reviewer | gpt-6.2-astra | 01a1f78b-63f0-7ac0-9661-01216d77edf7 | 35695 | 241152 | 0 | 2640 | 0.48762 | unjudged |
| spec-reviewer-02-clean-spec-approves/bug-spec | 1 | spec-reviewer | gpt-6.2-astra | 01a1f78c-96d2-7cf3-a32c-5267781f56d4 | 33445 | 151040 | 0 | 1149 | 0.37394 | unjudged |
| spec-reviewer-02-clean-spec-approves/bug-spec | 2 | spec-reviewer | gpt-6.2-astra | 01a1f78d-4afc-77f2-aa20-ac30bc1b1b7c | 34148 | 191360 | 0 | 1320 | 0.40253 | unjudged |
| spec-reviewer-02-clean-spec-approves/bug-spec | 3 | spec-reviewer | gpt-6.2-astra | 01a1f78e-1970-7171-8c82-01dc9eaf50a4 | 35693 | 153216 | 0 | 1498 | 0.40675 | unjudged |
| spec-reviewer-02-clean-spec-approves/plan-creates-a-file | 1 | spec-reviewer | gpt-6.2-astra | 01a1f78f-03fd-7712-a680-54e0557738bf | 37682 | 287232 | 0 | 2267 | 0.50703 | fail - verdict, accepted |
| spec-reviewer-02-clean-spec-approves/plan-creates-a-file | 2 | spec-reviewer | gpt-6.2-astra | 01a1f790-2a17-7560-97bc-b4d70a32efd5 | 48404 | 191488 | 0 | 931 | 0.50107 | fail - missing authenticated final write by spec-reviewer for verdicts/spec-reviewer.json |
| spec-reviewer-02-clean-spec-approves/plan-creates-a-file | 3 | spec-reviewer | gpt-6.2-astra | 01a1f790-db01-7c71-8584-9b6fd2d1a5da | 35442 | 152704 | 0 | 699 | 0.37258 | fail - missing authenticated final write by spec-reviewer for verdicts/spec-reviewer.json |
| spec-reviewer-03-revision-breaks-something-else | 1 | spec-reviewer | gpt-6.2-astra | 01a1f791-f530-7ef2-a297-29122770b24e | 34868 | 152960 | 0 | 2429 | 0.43729 | unjudged |
| spec-reviewer-03-revision-breaks-something-else | 2 | spec-reviewer | gpt-6.2-astra | 01a1f792-f42d-77e0-a0a8-4dc482427cd8 | 34731 | 152064 | 0 | 2507 | 0.43895 | unjudged |
| spec-reviewer-03-revision-breaks-something-else | 3 | spec-reviewer | gpt-6.2-astra | 01a1f794-0890-7023-b646-421f561d8c91 | 36796 | 155392 | 0 | 2621 | 0.46136 | unjudged |

## Team usage by model

These native per-model figures are already included in the parent session totals.

| Session | Model | Fresh | Cache read | Cache write | Output | USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 23754a09-e027-4bf6-bf67-54f4d4fb7b52 | claude-opus-5-5 | 54 | 1151094 | 124510 | 40577 | 1.93127 |
| 23754a09-e027-4bf6-bf67-54f4d4fb7b52 | claude-sonnet-5-5 | 34 | 366687 | 110956 | 25183 | 0.56596 |
| d7a51438-bed7-4ba9-9581-06b852f98ffc | claude-opus-5-5 | 54 | 1319125 | 121728 | 50631 | 2.14671 |
| d7a51438-bed7-4ba9-9581-06b852f98ffc | claude-sonnet-5-5 | 26 | 250022 | 104755 | 24837 | 0.53531 |
| 76c0dcee-642a-43e3-8862-2228e045fd65 | claude-opus-5-5 | 52 | 1175414 | 117435 | 49805 | 2.07032 |
| 76c0dcee-642a-43e3-8862-2228e045fd65 | claude-sonnet-5-5 | 26 | 255146 | 110623 | 31023 | 0.61235 |
| 56b22c47-3d83-4f18-852b-743006a23327 | claude-opus-5-5 | 52 | 1107772 | 122124 | 53925 | 2.15683 |
| 56b22c47-3d83-4f18-852b-743006a23327 | claude-sonnet-5-5 | 32 | 398213 | 124875 | 33348 | 0.68555 |

## Cost by case type

| Role | Sessions | Total USD | Mean USD |
| --- | ---: | ---: | ---: |
| Sonnet judge | 11 | 0.47681 | 0.04335 |
| spec-lead | 8 | 2.96813 | 0.37102 |
| spec-team | 4 | 10.70430 | 2.67607 |
| architect | 9 | 3.77819 | 0.41980 |
| Codex judge | 13 | 1.23861 | 0.09528 |
| security-auditor | 3 | 1.36244 | 0.45415 |
| spec-reviewer | 15 | 6.82650 | 0.45510 |

## Cost by case and variant

| Case and variant | Contestant USD | Judge USD | Total USD |
| --- | ---: | ---: | ---: |
| builder-01-bug-reproduce-first | 0.00000 | 0.08551 | 0.08551 |
| builder-02-security-criteria | 0.00000 | 0.14445 | 0.14445 |
| builder-03-repair-fix-and-dispute | 0.00000 | 0.14820 | 0.14820 |
| security-auditor-03-spec-stage/lead-dropped-a-mitigation | 0.00000 | 0.09864 | 0.09864 |
| spec-lead-01-draft-and-revise/bug-reproduce-first | 1.02171 | 0.24690 | 1.26861 |
| spec-lead-01-draft-and-revise/revision-answers-both-reviewers | 1.35138 | 0.35035 | 1.70173 |
| spec-lead-02-tier-promotion-runs-team | 3.09227 | 0.00000 | 3.09227 |
| spec-lead-03-ac-changing-conflict-escalates | 8.20707 | 0.00000 | 8.20707 |
| architect-01-new-project | 1.25121 | 0.21903 | 1.47024 |
| architect-02-split-temptation | 0.98031 | 0.25303 | 1.23334 |
| architect-03-existing-project-delta | 1.54668 | 0.16930 | 1.71597 |
| security-auditor-03-spec-stage/revision-edits-only-the-threat-model | 1.36244 | 0.00000 | 1.36244 |
| spec-reviewer-01-planted-defects/four-defects | 1.54108 | 0.00000 | 1.54108 |
| spec-reviewer-01-planted-defects/requirement-moved-to-non-goals | 1.38393 | 0.00000 | 1.38393 |
| spec-reviewer-02-clean-spec-approves/bug-spec | 1.18321 | 0.00000 | 1.18321 |
| spec-reviewer-02-clean-spec-approves/plan-creates-a-file | 1.38067 | 0.00000 | 1.38067 |
| spec-reviewer-03-revision-breaks-something-else | 1.33761 | 0.00000 | 1.33761 |
