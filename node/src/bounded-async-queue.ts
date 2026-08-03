interface QueuedValue<T> {
	readonly value: T;
	readonly weight: number;
}

interface QueueWaiter<T> {
	readonly resolve: (result: IteratorResult<T>) => void;
	readonly reject: (error: Error) => void;
}

/** Async iterator queue with independent item-count and retained-weight bounds. */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
	readonly #values: QueuedValue<T>[] = [];
	readonly #waiters: QueueWaiter<T>[] = [];
	#retainedWeight = 0;
	#closed = false;
	#failure: Error | null = null;

	constructor(
		readonly maxValues: number,
		readonly maxWeight: number,
		readonly overflowError: () => Error,
	) {}

	push(value: T, weight: number): void {
		if (!Number.isSafeInteger(weight) || weight < 0) {
			throw new Error("Queue weight must be a non-negative safe integer");
		}
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) {
			waiter.resolve({ done: false, value });
			return;
		}
		if (this.#values.length >= this.maxValues || weight > this.maxWeight - this.#retainedWeight) {
			throw this.overflowError();
		}
		this.#values.push({ value, weight });
		this.#retainedWeight += weight;
	}

	close(error?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#failure = error ?? null;
		if (error !== undefined) {
			this.#values.length = 0;
			this.#retainedWeight = 0;
		}
		for (const waiter of this.#waiters.splice(0)) {
			if (error === undefined) waiter.resolve({ done: true, value: undefined });
			else waiter.reject(error);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.#failure !== null) return Promise.reject(this.#failure);
				const queued = this.#values.shift();
				if (queued !== undefined) {
					this.#retainedWeight -= queued.weight;
					return Promise.resolve({ done: false, value: queued.value });
				}
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
			},
		};
	}
}
