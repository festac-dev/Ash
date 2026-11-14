import type { EngineEvent } from "../domain/types.js";

export type ServerEvent =
  | { type: "engine"; event: EngineEvent }
  | { type: "refresh"; reason: string }
  | { type: "server"; message: string; level: "info" | "warn" | "error" };

type Listener = (event: ServerEvent) => void;

/** In-process fan-out for SSE clients. Slow clients are dropped by the HTTP layer. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
