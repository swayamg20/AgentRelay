import { describe, expect, it, vi } from "vitest";
import { MAILBOX_EVENT_NOTIFY_CHANNEL } from "../services/mailbox-events.js";
import { MailboxSignalHub } from "./mailbox-signal.js";

describe("MailboxSignalHub", () => {
	it("fans content-free changes out only to the addressed recipient", async () => {
		let notify: (payload: string) => void = () => undefined;
		let ready: () => void = () => undefined;
		const unlisten = vi.fn(async () => undefined);
		const hub = new MailboxSignalHub({
			listen: vi.fn(async (channel, onNotify, onListen) => {
				expect(channel).toBe(MAILBOX_EVENT_NOTIFY_CHANNEL);
				notify = onNotify;
				ready = onListen ?? ready;
				return { unlisten };
			}),
		});
		const alice = vi.fn();
		const bob = vi.fn();
		const aliceId = "11111111-1111-4111-8111-111111111111";
		const bobId = "22222222-2222-4222-8222-222222222222";
		hub.subscribe(aliceId, alice);
		hub.subscribe(bobId, bob);

		await hub.start();
		ready();
		expect(alice).toHaveBeenLastCalledWith("resync");
		expect(bob).toHaveBeenLastCalledWith("resync");

		notify(aliceId);
		expect(alice).toHaveBeenLastCalledWith("changed");
		expect(bob).not.toHaveBeenCalledWith("changed");

		notify("not-a-recipient-id");
		expect(alice).toHaveBeenCalledTimes(2);
		await hub.stop();
		expect(alice).toHaveBeenLastCalledWith("closed");
		expect(unlisten).toHaveBeenCalledOnce();
	});

	it("unsubscribes a disconnected recipient", async () => {
		let notify: (payload: string) => void = () => undefined;
		const hub = new MailboxSignalHub({
			listen: async (_channel, onNotify) => {
				notify = onNotify;
				return { unlisten: async () => undefined };
			},
		});
		const listener = vi.fn();
		const recipient = "11111111-1111-4111-8111-111111111111";
		const unsubscribe = hub.subscribe(recipient, listener);
		await hub.start();
		unsubscribe();
		notify(recipient);
		expect(listener).not.toHaveBeenCalled();
		await hub.stop();
	});

	it("stops promptly while LISTEN startup is still pending and releases a late handle", async () => {
		let resolveListen: (handle: { unlisten: () => Promise<void> }) => void = () => undefined;
		const unlisten = vi.fn(async () => undefined);
		const hub = new MailboxSignalHub({
			listen: () =>
				new Promise((resolve) => {
					resolveListen = resolve;
				}),
		});
		const start = hub.start();

		await hub.stop();
		resolveListen({ unlisten });
		await start;

		expect(unlisten).toHaveBeenCalledOnce();
	});
});
