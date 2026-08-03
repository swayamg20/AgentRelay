import type { CapsuleErrorCode } from "./capsule-protocol.js";

export class CapsuleOperationError extends Error {
	constructor(
		readonly code: CapsuleErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CapsuleOperationError";
	}
}
