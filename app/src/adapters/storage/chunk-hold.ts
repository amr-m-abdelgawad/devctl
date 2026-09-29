/** The fields that name a chunk's stream. */
export type StreamChunk = { service: string; stream: string; pid: number };

/**
 * Chunks the pipeline refused, per stream in arrival order. A chunk is acked
 * only once accepted, so the sender's unacked credit bounds what is held and
 * stops its readers. A later chunk of a stream with held chunks, including
 * its end marker, always waits behind them; other streams are not held up.
 */
export class ChunkHoldQueue<T extends StreamChunk> {
  private readonly held = new Map<string, T[]>();

  constructor(
    private readonly accept: (chunk: T, force: boolean) => boolean,
    private readonly ack: (chunk: T) => void,
  ) {}

  get holding(): boolean {
    return this.held.size > 0;
  }

  /** Takes a chunk now or holds it. Returns false when it was held. */
  offer(chunk: T): boolean {
    const key = streamKey(chunk);
    const queue = this.held.get(key);
    if (queue !== undefined) {
      queue.push(chunk);
      return false;
    }
    if (this.accept(chunk, false)) {
      this.ack(chunk);
      return true;
    }
    this.held.set(key, [chunk]);
    return false;
  }

  /** Offers held chunks again in order. `force` takes them all, for shutdown. */
  retry(force = false): void {
    for (const [key, queue] of this.held) {
      while (queue.length > 0 && this.accept(queue[0]!, force)) {
        this.ack(queue.shift()!);
      }
      if (queue.length === 0) {
        this.held.delete(key);
      }
    }
  }
}

function streamKey(chunk: StreamChunk): string {
  return `${chunk.service}\0${chunk.stream}\0${chunk.pid}`;
}
