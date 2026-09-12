import { randomUUID } from "node:crypto";
import { z } from "zod";
import { markTeammateValue } from "../../src/provenance.js";

export const probeReferenceSchema = z
	.object({
		session_id: z.string().uuid(),
		message_id: z.string().uuid(),
		attempt_id: z.string().uuid(),
	})
	.strict();

export type ProbeReference = z.infer<typeof probeReferenceSchema>;

export const probeReplySchema = probeReferenceSchema.extend({
	answer: z.string().min(1).max(256),
});

export interface ProbeEvent {
	stage: "signal_written" | "turn_observed" | "reply_recorded" | "reply_replayed";
	reference: ProbeReference;
	sequence: number;
}

interface ProbeTurn {
	reference: ProbeReference;
	challenge: string;
	observed: boolean;
	reply: { reply_id: string; answer: string } | null;
}

/** Synthetic, in-memory fixture. Its replies are not durable Relay receipts. */
export class ProbeSession {
	readonly #turns: ProbeTurn[];
	readonly #expiresAt: number;
	readonly #onEvent: (event: ProbeEvent) => void;
	readonly #now: () => number;
	#stopped = false;

	constructor(options: {
		turns: number;
		expiresAt: number;
		onEvent: (event: ProbeEvent) => void;
		now?: () => number;
	}) {
		const count = z.number().int().min(1).max(3).parse(options.turns);
		this.#expiresAt = z.number().finite().parse(options.expiresAt);
		this.#onEvent = options.onEvent;
		this.#now = options.now ?? Date.now;
		const sessionId = randomUUID();
		this.#turns = Array.from({ length: count }, () => ({
			reference: {
				session_id: sessionId,
				message_id: randomUUID(),
				attempt_id: randomUUID(),
			},
			challenge: randomUUID(),
			observed: false,
			reply: null,
		}));
	}

	nextReference(): ProbeReference | null {
		this.#assertActive();
		const turn = this.#turns.find((candidate) => candidate.reply === null);
		return turn ? { ...turn.reference } : null;
	}

	markSignalWritten(input: unknown): void {
		const turn = this.#getTurn(input);
		this.#emit("signal_written", turn);
	}

	receive(input: unknown) {
		const turn = this.#getTurn(input);
		// A notification is an attention hint, not authority to read this reference.
		if (!turn.observed) {
			turn.observed = true;
			this.#emit("turn_observed", turn);
		}
		return {
			reference: { ...turn.reference },
			peer_data: markTeammateValue("synthetic-peer@agentrelay", {
				challenge: turn.challenge,
			}),
		};
	}

	reply(input: unknown): { reply_id: string; replayed: boolean } {
		const { answer, ...reference } = probeReplySchema.parse(input);
		const turn = this.#getTurn(reference);
		if (!turn.observed) throw new Error("Receive the probe turn before replying");
		if (turn.reply) {
			if (turn.reply.answer !== answer) throw new Error("Conflicting probe reply");
			this.#emit("reply_replayed", turn);
			return { reply_id: turn.reply.reply_id, replayed: true };
		}
		if (answer !== `PONG:${turn.challenge}`) throw new Error("Probe challenge answer mismatch");
		turn.reply = { reply_id: randomUUID(), answer };
		this.#emit("reply_recorded", turn);
		return { reply_id: turn.reply.reply_id, replayed: false };
	}

	stop(): void {
		this.#stopped = true;
	}

	#assertActive(): void {
		if (this.#stopped || this.#now() >= this.#expiresAt) {
			throw new Error("Probe session is stopped or expired");
		}
	}

	#getTurn(input: unknown): ProbeTurn {
		this.#assertActive();
		const reference = probeReferenceSchema.parse(input);
		const turn = this.#turns.find(
			(candidate) =>
				candidate.reference.session_id === reference.session_id &&
				candidate.reference.message_id === reference.message_id &&
				candidate.reference.attempt_id === reference.attempt_id,
		);
		if (!turn) throw new Error("Unknown probe reference");
		return turn;
	}

	#emit(stage: ProbeEvent["stage"], turn: ProbeTurn): void {
		this.#onEvent({
			stage,
			reference: { ...turn.reference },
			sequence: this.#turns.indexOf(turn) + 1,
		});
	}
}
