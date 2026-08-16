export interface TransactionAdapter<S> { snapshot(): Promise<S>; restore(snapshot: S): Promise<void>; apply(): Promise<void> }
export class TransactionError extends Error { constructor(message: string, readonly cause?: unknown, readonly rollbackError?: unknown) { super(message) } }
/** Applies registered steps atomically from the caller's perspective. */
export class Transaction<S> {
  private readonly steps: Array<{ name: string; adapter: TransactionAdapter<S> }> = []
  add(name: string, adapter: TransactionAdapter<S>): this { this.steps.push({ name, adapter }); return this }
  async commit(): Promise<void> {
    const completed: Array<{ name: string; adapter: TransactionAdapter<S>; snapshot: S }> = []
    try {
      for (const step of this.steps) {
        // Record the checkpoint before applying: an adapter may mutate then throw.
        const snapshot = await step.adapter.snapshot()
        completed.push({ ...step, snapshot })
        await step.adapter.apply()
      }
    } catch (cause) {
      let rollbackError: unknown
      for (const step of completed.reverse()) try { await step.adapter.restore(step.snapshot) } catch (error) { rollbackError ??= error }
      throw new TransactionError('transaction failed and rollback was attempted', cause, rollbackError)
    }
  }
}
export class MemoryAdapter<T> implements TransactionAdapter<T> {
  constructor(private value: T, private readonly next: () => T) {}
  async snapshot(): Promise<T> { return structuredClone(this.value) }
  async restore(snapshot: T): Promise<void> { this.value = structuredClone(snapshot) }
  async apply(): Promise<void> { this.value = this.next() }
  get current(): T { return this.value }
}
