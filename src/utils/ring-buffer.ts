export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('RingBuffer limit must be a positive integer.');
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  pushMany(items: T[]): void {
    for (const item of items) {
      this.push(item);
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  tail(count: number): T[] {
    if (count <= 0) {
      return [];
    }
    return this.items.slice(-count);
  }
}
