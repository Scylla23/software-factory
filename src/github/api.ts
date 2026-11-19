import { baseHeaders, type Fetch, GITHUB_API, GITHUB_TIMEOUT_MS, GitHubError, githubMessage, type InstallationToken } from "./app";

/** One repository, called with one installation token. */
export class RepoClient {
  constructor(readonly owner: string, readonly repo: string, private readonly token: InstallationToken, private readonly fetchImpl: Fetch = fetch) {
    for (const part of [owner, repo]) if (!/^[A-Za-z0-9._-]{1,100}$/.test(part)) throw new Error(`not a GitHub name: ${JSON.stringify(part)}`);
    if (!token.repositories.includes(repo)) throw new Error(`token is not scoped to ${repo}`);
  }

  /** `/repos/<owner>/<repo>` plus `path`. */
  get base(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  /**
   * Calls the API and returns the parsed JSON body, or null for 404 when `allow404` is set.
   * Any other status outside 2xx throws a GitHubError with GitHub's message only.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<T | null> {
    if (!path.startsWith("/")) throw new Error(`API path must start with /: ${path}`);
    const res = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: { ...baseHeaders(), Authorization: `Bearer ${this.token.secret()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      redirect: "error",
    });
    if (res.status === 404 && opts.allow404) return null;
    if (res.status < 200 || res.status > 299) throw new GitHubError(`${method} ${path} -> ${res.status}: ${await githubMessage(res)}`, res.status);
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }
}
