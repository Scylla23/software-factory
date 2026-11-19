import { config } from "../../factory.config";
import type { IssueComment } from "../github/pulls";
import type { Approval, Store, Task } from "./store";

export function specDecision(task: Task, comment: IssueComment, own: boolean): Approval | null {
  if (!comment.body.startsWith("/approve")) return null;
  const sha = /^\/approve ([0-9a-f]{40})$/.exec(comment.body)?.[1] ?? "";
  const reason =
    own || comment.body.includes("<!-- factory:")
      ? "factory comment"
      : comment.authorId !== config.ownerId
        ? "unauthorized sender"
        : sha !== task.spec
          ? "stale or invalid spec SHA"
          : "approved spec";
  return { kind: "comment", id: comment.id, actor: comment.authorId ?? 0, sha, accepted: reason === "approved spec", reason };
}

export function pendingSpec(store: Store, task: Task, comments: IssueComment[]) {
  for (const c of comments) {
    if (store.db.query("SELECT id FROM approvals WHERE kind='comment' AND id=?").get(c.id)) continue;
    const own = !!store.db.query("SELECT id FROM factory_comments WHERE id=?").get(c.id);
    const event = specDecision(task, c, own);
    if (event?.accepted) return event;
    if (event) store.record(task.id, event);
  }
  return null;
}

export function pendingReverification(store: Store, task: Task, comments: IssueComment[], announcement: number, prHead: string) {
  if (!store.canReverify(task) || prHead !== task.head) return null;
  let resolution: Approval | null = null;
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    if (c.id === resolution?.id) continue;
    if (!c.body.startsWith("/reverify") || store.db.query("SELECT id FROM approvals WHERE kind='comment' AND id=?").get(c.id))
      continue;
    const sha = /^\/reverify ([0-9a-f]{40})$/.exec(c.body)?.[1] ?? "";
    const own = !!store.db.query("SELECT id FROM factory_comments WHERE id=?").get(c.id);
    const reason =
      own || c.body.includes("<!-- factory:")
        ? "factory comment"
        : c.authorId !== config.ownerId
          ? "unauthorized sender"
          : c.id <= announcement
            ? "command predates escalation"
            : sha !== task.head || c.body !== `/reverify ${task.head}`
              ? "stale or invalid reviewed head"
              : "owner requested re-verification";
    // accepted records an approval. A resolution authorizes only another verification.
    const event: Approval = { kind: "comment", id: c.id, actor: c.authorId ?? 0, sha, accepted: false, reason };
    if (reason === "owner requested re-verification") {
      if (!resolution) {
        resolution = event;
        continue;
      }
      event.reason = `duplicate of re-verification comment ${resolution.id}`;
    }
    store.record(task.id, event);
  }
  return resolution;
}

export interface Review {
  id: number;
  user: { id: number };
  state: string;
  commit_id: string | null;
  submitted_at: string | null;
}
export function headDecision(task: Task, reviews: Review[]) {
  const latest = reviews
    .filter((r) => r.user.id === config.ownerId && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
    .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "") || a.id - b.id)
    .at(-1);
  if (!latest) return null;
  const accepted = latest.state === "APPROVED" && latest.commit_id === task.head;
  return {
    kind: "review" as const,
    id: latest.id,
    actor: latest.user.id,
    sha: latest.commit_id ?? "",
    accepted,
    reason: accepted ? "approved verified head" : "stale or unapproved head",
  };
}
