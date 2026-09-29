/**
 * Retains body text under a byte budget. Evicting a body drops the text and
 * leaves the caller's metadata in place.
 */
export class BodyStore {
  private readonly text = new Map<string, string>();
  private readonly order: string[] = [];
  private used = 0;

  constructor(private maxBytes: number) {}

  get budget(): number {
    return this.maxBytes;
  }

  byteSize(): number {
    return this.used;
  }

  setBudget(maxBytes: number): string[] {
    this.maxBytes = maxBytes;
    return this.evict();
  }

  /** Stores `body`. Returns ids whose bodies were evicted to make room, including `id` if it could not fit. */
  put(id: string, body: string): string[] {
    this.drop(id);
    const bytes = Buffer.byteLength(body);
    if (this.maxBytes > 0 && bytes > this.maxBytes) {
      return [id];
    }
    this.text.set(id, body);
    this.order.push(id);
    this.used += bytes;
    return this.evict();
  }

  get(id: string): string | undefined {
    return this.text.get(id);
  }

  drop(id: string): void {
    const current = this.text.get(id);
    if (current === undefined) {
      return;
    }
    this.used -= Buffer.byteLength(current);
    this.text.delete(id);
    const index = this.order.indexOf(id);
    if (index >= 0) {
      this.order.splice(index, 1);
    }
  }

  shedAll(): string[] {
    const ids = [...this.order];
    this.text.clear();
    this.order.length = 0;
    this.used = 0;
    return ids;
  }

  private evict(): string[] {
    const evicted: string[] = [];
    while (this.maxBytes > 0 && this.used > this.maxBytes && this.order.length > 0) {
      const id = this.order.shift();
      if (id === undefined) {
        break;
      }
      const body = this.text.get(id);
      this.text.delete(id);
      if (body !== undefined) {
        this.used -= Buffer.byteLength(body);
      }
      evicted.push(id);
    }
    if (this.used < 0) {
      this.used = 0;
    }
    return evicted;
  }
}
