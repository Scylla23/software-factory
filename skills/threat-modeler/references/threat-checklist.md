# Threat checklist

Prompts for finding threats, organized by what the task contains.
Use the sections that apply; a prompt that does not attach to an entry point in this task produces no row.
The security auditor uses the same list in reverse, to check that each applicable prompt was either mitigated or consciously accepted.

The six STRIDE questions apply to every entry point and are the backstop when nothing below fits:
can the actor pretend to be someone else (spoofing), change data they should not (tampering), deny having done something (repudiation), see data they should not (information disclosure), stop it working for others (denial of service), or do more than their role allows (elevation of privilege)?

## Any route or handler

- Is the caller authenticated where it must be, and is that checked on the server?
- Is the caller authorized for this specific record, not only for this kind of action?
  Try each route as a different signed-in user with another user's ids.
- Is every input parsed into a typed value at the boundary, with unknown fields rejected?
- Does a state-changing route accept cross-site requests (CSRF), and is it safe if it is repeated?
- Do error responses reveal stack traces, queries, or whether an account exists?
- Can one caller exhaust it: unbounded list sizes, expensive queries, no rate limit on sign-in or on anything that sends mail or costs money?

## Authentication and sessions

- Where are credentials verified, and is the comparison done by the auth library?
- How are sessions created, stored, rotated on sign-in, and ended on sign-out and password change?
- Cookie flags: `HttpOnly`, `Secure`, `SameSite`, scope, and lifetime.
- Account recovery and email change: can they be used to take over an account?
- Can sign-up, sign-in, or reset be used to enumerate which emails have accounts?
- Are tokens (reset, invite, magic link) single-use, short-lived, and unguessable?

## Data the app stores

- Which fields are personal or secret, and who can read each through any route, export, or log?
- Are secrets and tokens stored hashed or encrypted where they only need to be compared?
- Is tenant or user scoping applied in the data layer, or does each query have to remember it?
- What does deletion leave behind: rows, files, caches, search indexes?

## Rendering and the browser

- Is any user-supplied content rendered as HTML, as a URL, as CSS, or inside a script?
- Are redirects built from input restricted to known destinations?
- Are third-party scripts or embeds added, and what can they read?
- Does the page expose data in its markup or client state that the user should not see?

## Files

- Upload: size, type, and content checks; where files are stored; whether a stored file can be served as active content.
- Download and paths: can input reach a filesystem path (traversal) or choose which file is served?

## Outbound requests and integrations

- Is any URL, host, or header of an outbound request built from input (SSRF)?
- Webhooks in: is the signature verified before the body is trusted, and is replay handled?
- Webhooks and callbacks out: what is sent, and to an address who controls?
- What happens when the third party is down, slow, or returns something unexpected?

## Database and queries

- Is any query built by string concatenation or with raw fragments from input?
- Can a caller sort, filter, or page on arbitrary columns?
- Do migrations in this task expose data, drop constraints, or widen access?

## Payments

- Is the amount and the purchased item decided on the server?
- Is entitlement granted only from a verified payment event, and exactly once?
- Can a webhook be replayed or forged to grant entitlement?

## AI and model features

- Can content the model reads (a document, a web page, another user's message) instruct it to take actions or reveal data (prompt injection)?
- What tools can the model call, with whose authority, and is a human approval required for anything irreversible?
- Is model output rendered as HTML or executed?
- Can one user's data reach another user through prompts, caches, or shared context?
- Are there limits on cost per user?

## Secrets, configuration, and the supply chain

- Are secrets read from the environment and absent from code, fixtures, logs, and client bundles?
- Are any new dependencies added, and do they run install scripts or need network or filesystem access?
- Do changes to CI workflows, build scripts, or package scripts run with credentials?
- Are security headers and CORS set deliberately, with origins listed rather than wildcarded?

## References

For people; agents have no network.
All were live on 2026-11-19.

- OWASP Threat Modeling Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- STRIDE categories: https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats
- OWASP Application Security Verification Standard: https://asvs.owasp.org/
- CWE Top 25: https://cwe.mitre.org/top25/
