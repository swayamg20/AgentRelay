import { describe, expect, it } from "vitest";
import { BoundedAsyncQueue } from "./bounded-async-queue.js";

describe("BoundedAsyncQueue", () => {
	it("enforces retained item and byte-like weight bounds", async () => {
		const queue = new BoundedAsyncQueue<string>(2, 3, () => new Error("overflow"));
		const iterator = queue[Symbol.asyncIterator]();
		queue.push("first", 2);
		queue.push("second", 1);
		expect(() => queue.push("too-many", 0)).toThrow("overflow");
		expect(await iterator.next()).toEqual({ done: false, value: "first" });
		queue.push("third", 2);
		expect(() => queue.push("too-heavy", 1)).toThrow("overflow");
	});

	it("makes a fatal close take precedence over buffered values", async () => {
		const failure = new Error("fatal");
		const queue = new BoundedAsyncQueue<string>(2, 2, () => new Error("overflow"));
		queue.push("terminal-looking-value", 1);
		queue.close(failure);
		await expect(queue[Symbol.asyncIterator]().next()).rejects.toBe(failure);
	});

	it("drains buffered values after a normal close", async () => {
		const queue = new BoundedAsyncQueue<string>(2, 2, () => new Error("overflow"));
		const iterator = queue[Symbol.asyncIterator]();
		queue.push("value", 1);
		queue.close();
		expect(await iterator.next()).toEqual({ done: false, value: "value" });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
	});
});
