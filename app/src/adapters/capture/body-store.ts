import { stringBytes } from "../../domain/logs/size.ts";

/**
 * Byte ledger for capture bodies under one budget. The stores hold each body
 * once; this tracks its size in arrival order and names the oldest ids that
 * must drop their bodies to stay under the budget. Evicting a body leaves the
 * caller's metadata in place.
 */
export class BodyBudget {
  // Insertion order is eviction order; re-putting an id moves it to the end.
  private readonly sizes = new Map<string, number>();
  private used = 0;

  constructor(private readonly maxBytes: number) {}

  byteSize(): number {
    return this.used;
  }

  /** Records `bytes` for `id`. Returns ids whose bodies must go, including `id` when it alone exceeds the budget. */
  put(id: string, bytes: number): string[] {
    this.drop(id);
    if (bytes <= 0) {
      return [];
    }
    if (this.maxBytes > 0 && bytes > this.maxBytes) {
      return [id];
    }
    this.sizes.set(id, bytes);
    this.used += bytes;
    return this.evict();
  }

  drop(id: string): void {
    const bytes = this.sizes.get(id);
    if (bytes === undefined) {
      return;
    }
    this.sizes.delete(id);
    this.used -= bytes;
  }

  shedAll(): string[] {
    const ids = [...this.sizes.keys()];
    this.sizes.clear();
    this.used = 0;
    return ids;
  }

  private evict(): string[] {
    const evicted: string[] = [];
    for (const [id, bytes] of this.sizes) {
      if (this.maxBytes <= 0 || this.used <= this.maxBytes) {
        break;
      }
      this.sizes.delete(id);
      this.used -= bytes;
      evicted.push(id);
    }
    return evicted;
  }
}

/**
 * Heap bytes a body string occupies, by the log ring's rule. One character
 * outside Latin-1 makes the engine store the whole string at two bytes per
 * unit, so a UTF-8 count would undercount such a body by up to half.
 */
export function textBytes(text: string | undefined): number {
  return text === undefined ? 0 : stringBytes(text);
}
