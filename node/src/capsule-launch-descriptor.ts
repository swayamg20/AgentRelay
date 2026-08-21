import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { sessionInputSchema, uuidSchema } from "@agentrelay/protocol";
import { z } from "zod";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import { codexSandboxRecoveryExpectationSchema } from "./codex-sandbox-contract.js";

export const CAPSULE_DESCRIPTOR_FILE = "launch.json";
export const CODEX_CAPSULE_RUNTIME_CONTRACT = "agentrelay/codex-capsule/v3";

const MAX_CAPSULE_SOCKET_PATH_BYTES = 100;
const capsuleDescriptorCommonShape = {
	capsule_id: uuidSchema,
	capability_token: z.string().regex(/^ar_capsule_[a-f0-9]{64}$/),
	socket_path: z
		.string()
		.min(1)
		.max(512)
		.refine((value) => !value.includes("\0")),
	session: sessionInputSchema,
};

export const fakeCapsuleOutcomeSchema = z.enum(["ready", "reply"]);

export const fakeCapsuleLaunchDescriptorSchema = z
	.object({
		schema_version: z.literal(1),
		...capsuleDescriptorCommonShape,
		runtime: z
			.object({
				kind: z.literal("fake"),
				outcome: fakeCapsuleOutcomeSchema,
				completion_delay_ms: z.number().int().min(0).max(60_000),
			})
			.strict(),
	})
	.strict();

export const codexCapsuleLaunchDescriptorSchema = z
	.object({
		schema_version: z.literal(3),
		...capsuleDescriptorCommonShape,
		runtime: z
			.object({
				kind: z.literal("codex"),
				runtime_contract: z.literal(CODEX_CAPSULE_RUNTIME_CONTRACT),
				codex_cli_version: z.literal(SUPPORTED_CODEX_CLI_VERSION),
				containment: codexSandboxRecoveryExpectationSchema,
			})
			.strict(),
	})
	.strict();

export const capsuleLaunchDescriptorSchema = z.discriminatedUnion("schema_version", [
	fakeCapsuleLaunchDescriptorSchema,
	codexCapsuleLaunchDescriptorSchema,
]);

export type FakeCapsuleOutcome = z.infer<typeof fakeCapsuleOutcomeSchema>;
export type FakeCapsuleLaunchDescriptor = z.infer<typeof fakeCapsuleLaunchDescriptorSchema>;
export type CodexCapsuleLaunchDescriptor = z.infer<typeof codexCapsuleLaunchDescriptorSchema>;
export type CapsuleLaunchDescriptor = z.infer<typeof capsuleLaunchDescriptorSchema>;

export async function readCapsuleLaunchDescriptor(
	directory: string,
): Promise<CapsuleLaunchDescriptor> {
	assertUnixSocketSupport();
	const descriptor = capsuleLaunchDescriptorSchema.parse(
		await readSecureJson(join(directory, CAPSULE_DESCRIPTOR_FILE)),
	);
	assertValidCapsuleSocketPath(descriptor.socket_path, descriptor.capsule_id);
	return descriptor;
}

export async function readFakeCapsuleLaunchDescriptor(
	directory: string,
): Promise<FakeCapsuleLaunchDescriptor> {
	const descriptor = await readCapsuleLaunchDescriptor(directory);
	if (descriptor.schema_version !== 1) {
		throw new Error("Capsule launch descriptor does not select the fake runtime");
	}
	return descriptor;
}

export async function readCodexCapsuleLaunchDescriptor(
	directory: string,
): Promise<CodexCapsuleLaunchDescriptor> {
	const descriptor = await readCapsuleLaunchDescriptor(directory);
	if (descriptor.schema_version !== 3) {
		throw new Error("Capsule launch descriptor does not select Codex");
	}
	return descriptor;
}

export function capsuleSocketPath(capsuleId: string): string {
	assertUnixSocketSupport();
	const owner = process.getuid?.() ?? "unknown";
	const temporaryRoot = tmpdir();
	if (!isAbsolute(temporaryRoot) || normalize(temporaryRoot) !== temporaryRoot) {
		throw new Error("Capsule descriptor contains an invalid local socket path");
	}
	const candidate = join(
		realpathSync(temporaryRoot),
		`ar-capsules-${owner}`,
		capsuleSocketFilename(capsuleId),
	);
	const path =
		Buffer.byteLength(candidate, "utf8") <= MAX_CAPSULE_SOCKET_PATH_BYTES
			? candidate
			: join(realpathSync("/tmp"), `ar-capsules-${owner}`, capsuleSocketFilename(capsuleId));
	assertValidCapsuleSocketPath(path, capsuleId);
	return path;
}

function assertValidCapsuleSocketPath(path: string, capsuleId: string): void {
	const expectedSocketDirectory = `ar-capsules-${process.getuid?.() ?? "unknown"}`;
	let canonicalRoot = false;
	try {
		const root = dirname(dirname(path));
		canonicalRoot = realpathSync(root) === root;
	} catch {
		canonicalRoot = false;
	}
	if (
		!isAbsolute(path) ||
		normalize(path) !== path ||
		!canonicalRoot ||
		Buffer.byteLength(path, "utf8") > MAX_CAPSULE_SOCKET_PATH_BYTES ||
		basename(dirname(path)) !== expectedSocketDirectory ||
		basename(path) !== capsuleSocketFilename(capsuleId)
	) {
		throw new Error("Capsule descriptor contains an invalid local socket path");
	}
}

function capsuleSocketFilename(capsuleId: string): string {
	const digest = createHash("sha256").update(capsuleId, "utf8").digest("hex").slice(0, 24);
	return `${digest}.sock`;
}

function assertUnixSocketSupport(): void {
	if (process.platform === "win32") {
		throw new Error("Persistent Mission capsules require Unix domain sockets");
	}
}

async function readSecureJson(path: string): Promise<unknown> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Cannot open capsule file: ${path}`, { cause: error });
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Capsule file is not regular: ${path}`);
		if ((stats.mode & 0o777) !== 0o600) {
			throw new Error(`Capsule file must have mode 0600: ${path}`);
		}
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}
