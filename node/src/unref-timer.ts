import { setTimeout as delay } from "node:timers/promises";

export function waitUnref(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return delay(milliseconds, undefined, { ref: false, signal });
}

export async function raceWithUnrefTimeout<T>(
	operation: Promise<T>,
	milliseconds: number,
	signal?: AbortSignal,
): Promise<{ readonly kind: "value"; readonly value: T } | { readonly kind: "timeout" }> {
	const timerController = new AbortController();
	const timerSignal =
		signal === undefined
			? timerController.signal
			: AbortSignal.any([signal, timerController.signal]);
	try {
		return await Promise.race([
			operation.then((value) => ({ kind: "value" as const, value })),
			waitUnref(milliseconds, timerSignal).then(() => ({ kind: "timeout" as const })),
		]);
	} finally {
		timerController.abort();
	}
}
