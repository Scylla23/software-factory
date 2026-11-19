import type { Attempt, State, Store, Task } from "./store";

export class Uncertain extends Error {}
export class AgentFailed extends Error {}
export type Stages = Record<Exclude<State, "done" | "failed">, (task: Task) => Task | null | Promise<Task | null>>;

/** Each stage receives the committed visit it is executing. Returning null parks that visit. */
export async function drive(store: Store, initial: Task, stages: Stages) {
  let task = initial;
  while (task.state !== "done" && task.state !== "failed") {
    try {
      const next = await stages[task.state](task);
      if (!next) break;
      task = next;
    } catch (error) {
      if (error instanceof Uncertain && task.state !== "escalated") {
        task = store.move(task, "escalated", { reason: error.message });
        continue;
      }
      if (error instanceof AgentFailed && task.state !== "escalated")
        return store.move(task, "failed", { reason: error.message });
      throw error;
    }
  }
  return task;
}

export async function effect<T>(
  store: Store,
  task: Task,
  action: string,
  intent: unknown,
  perform: (attempt: Attempt) => Promise<T>,
) {
  const attempt = store.plan(task, action, intent);
  if (attempt.result !== null) return JSON.parse(attempt.result) as T;
  const result = await perform(attempt);
  store.finish(attempt.id, result);
  return result;
}
