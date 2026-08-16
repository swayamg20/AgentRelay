import {
	type CodexSandboxRecoveryExpectation,
	recoverCodexSandboxContainment,
} from "../src/codex-sandbox-containment.js";

const serialized = process.argv[2];
if (serialized === undefined) throw new Error("Recovery expectation is required");
const expectation = JSON.parse(serialized) as CodexSandboxRecoveryExpectation;
const containment = await recoverCodexSandboxContainment(expectation);
process.stdout.write(`${JSON.stringify(containment.evidence)}\n`);
