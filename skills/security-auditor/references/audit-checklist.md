# Security audit checklist (code stage)

What to look for in a diff, what proves it, and how it is usually rated.
`threat-modeler/references/threat-checklist.md` asks what could go wrong with a design; this file asks whether the code in front of you lets it happen.
Use the sections the diff touches.

A finding is proven by one of three things: a probe test that performs the action as the wrong actor and shows the result, a trace from an entry point to the dangerous call with each step cited by file and line, or the offending line itself when the line is the defect (a committed secret, a disabled check).

## Authorization on every record

- For each route, handler, job, or query the diff adds or changes, find where the caller's identity enters the lookup.
  A lookup by id alone, followed by no ownership check, is cross-user access.
- Check reads and writes separately; a guarded read next to an unguarded update is common.
- Check list endpoints, exports, search, and counts, which leak through filters and totals.
- Check that the check is on the server, and that it uses the session's identity rather than an id from the request.
- Proof: a probe as a second user, expecting refusal.
- Usual rating: high; critical when no session is needed at all.

## Input handling

- Every request body, query, header, path parameter, webhook, and file is parsed at the boundary into a typed value.
- Mass assignment: a body spread or assigned onto a record lets the caller set fields such as owner, role, id, or price.
- Unknown fields are rejected or dropped deliberately; numeric, length, and enum bounds exist.
- Proof: the line that copies the body, and a probe that sets a privileged field.
- Usual rating: high when a privileged field is writable; medium for missing bounds.

## Injection

- SQL or query languages: string concatenation or template interpolation of input into a query, including `ORDER BY`, column names, and `LIMIT`.
- Shell: input reaching `exec`, `spawn` with a shell, or a command string.
- Paths: input joined into a filesystem path without normalizing and confining it.
- Templates, regular expressions, and dynamic code (`eval`, `Function`, dynamic `import`) built from input.
- Proof: the trace from the entry point to the sink.
- Usual rating: critical for SQL, shell, and code; high for paths.

## Output and the browser

- User-controlled content rendered as HTML (`innerHTML`, `dangerouslySetInnerHTML`, unescaped template output), as a URL (`href`, `src`, redirects), or inside a script or style.
- URL schemes: a link built from input must allow only `http` and `https`.
- Redirect targets taken from input are restricted to same-origin or an allowlist.
- Cookies set by the diff carry `HttpOnly`, `Secure`, and `SameSite`; state-changing routes that rely on cookies have CSRF protection.
- CORS origins are listed, not wildcarded, when credentials are allowed.
- Usual rating: high for stored script injection; medium for reflected or self-only cases.

## Authentication, sessions, and tokens

- Passwords and secrets are compared and hashed by the auth library, never by hand.
- Sessions rotate on sign-in and end on sign-out and password change.
- Reset, invite, and magic-link tokens are random from a cryptographic source, single-use, and short-lived.
- Responses and timing do not reveal whether an account exists.
- A check that was present at `baseSha` and is gone or weakened at `headSha` is a finding even when no criterion mentions it.
- Usual rating: critical for a bypass; high for takeover paths.

## Secrets and sensitive data

- Keys, tokens, passwords, private keys, or `.env` contents added anywhere in the diff, including tests, fixtures, and comments.
  Report the file, line, and kind of secret; never copy the value into the verdict.
- Secrets or personal data written to logs, error messages, analytics events, or client bundles.
- Sensitive fields returned by an API because a whole record is serialized.
- Usual rating: critical for a live-looking credential; high for personal data exposure.

## Outbound requests and integrations

- A URL, host, or header of an outbound request built from input (server-side request forgery).
- Incoming webhooks verified by signature before the body is used, with replay handled.
- Payment amounts, prices, and entitlements decided on the server from a verified event.
- Usual rating: high.

## Dependencies, build, and CI

- A dependency the spec does not name, or a version or source (git URL, tarball) that differs from the manifest's registry entry.
- Lockfile changes that do not correspond to a manifest change.
- New install, build, or lifecycle scripts, and changes to CI workflows, git hooks, or anything that runs with credentials.
- Usual rating: high for an unapproved dependency or a workflow change that touches secrets; otherwise medium.

## AI and model features

- Model output rendered as HTML, executed, or used to choose a tool call without a check.
- Untrusted content (documents, pages, other users' text) placed where the model treats it as instruction, with tools available.
- One user's data reaching another through shared prompts, caches, or memory.
- Irreversible actions taken without the approval step the spec requires.
- Usual rating: high when a tool can act on data or money.

## Failure behavior

- A security decision that fails open: an exception, timeout, or missing configuration that results in access being granted.
- Error responses that include stack traces, queries, or internal paths.
- Limits on anything that sends mail, costs money, or is expensive to compute.
- Usual rating: high for failing open; medium otherwise.

## References

For people; agents have no network.
All were live on 2026-11-19.

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- OWASP Cheat Sheet Series: https://cheatsheetseries.owasp.org/
- OWASP Application Security Verification Standard: https://asvs.owasp.org/
- CWE Top 25: https://cwe.mitre.org/top25/
