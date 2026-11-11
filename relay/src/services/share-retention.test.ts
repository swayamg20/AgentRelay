import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client.js";
import type { Logger } from "../logger.js";
import { ShareRetentionSweep } from "./share-retention.js";
import { deleteExpiredShareContent } from "./shares.js";

vi.mock("./shares.js", () => ({ deleteExpiredShareContent: vi.fn() }));

const deleteContent = vi.mocked(deleteExpiredShareContent);
const db = {} as Database;

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("in-process share retention", () => {
	it("sweeps on startup, drains batches, repeats, and stops its idle timer", async () => {
		vi.useFakeTimers();
		deleteContent.mockResolvedValueOnce(100).mockResolvedValue(0);
		const logger = { warn: vi.fn() } as unknown as Logger;
		const sweep = new ShareRetentionSweep(db, logger);
		sweep.start();
		sweep.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(deleteContent).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(deleteContent).toHaveBeenCalledTimes(3);
		await sweep.stop();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(deleteContent).toHaveBeenCalledTimes(3);
	});

	it("retries a failure without logging its raw content or diagnostic", async () => {
		vi.useFakeTimers();
		deleteContent
			.mockRejectedValueOnce(new Error("sensitive body in database failure"))
			.mockResolvedValue(0);
		const warn = vi.fn();
		const sweep = new ShareRetentionSweep(db, { warn } as unknown as Logger);
		sweep.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(warn).toHaveBeenCalledWith(
			{ event: "share.retention_failed" },
			"share retention sweep failed",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive body");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(deleteContent).toHaveBeenCalledTimes(2);
		await sweep.stop();
	});

	it("waits for an in-flight transaction before stopping", async () => {
		let finish: (count: number) => void = () => {
			throw new Error("sweep not started");
		};
		deleteContent.mockImplementation(
			() =>
				new Promise<number>((resolve) => {
					finish = resolve;
				}),
		);
		const sweep = new ShareRetentionSweep(db, { warn: vi.fn() } as unknown as Logger);
		sweep.start();
		let stopped = false;
		const stop = sweep.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		finish(100);
		await stop;
		expect(stopped).toBe(true);
		expect(deleteContent).toHaveBeenCalledTimes(1);
	});
});
