import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { digestCanonicalJson } from "./capsule-correlation.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import type { LocalFilesystemIdentity, PreparedMissionWorkspace } from "./mission-workspace.js";
import { publishPrivateJsonExclusive, readPrivateJsonIfPresent } from "./private-state-file.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const filesystemIdentitySchema = z
	.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
	.strict();
const localPathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => !value.includes("\0"), "Path cannot contain NUL")
	.refine((value) => isAbsolute(value), "Path must be absolute")
	.refine((value) => normalize(value) === value, "Path must be normalized");
const boundPathSchema = z
	.object({ path: localPathSchema, identity: filesystemIdentitySchema })
	.strict();

export const RUNTIME_CONTAINMENT_BACKEND = "codex_bubblewrap_0_146";

export const runtimeContainmentBindingSchema = z
	.object({
		backend: z.literal(RUNTIME_CONTAINMENT_BACKEND),
		runtime_version: z.literal(SUPPORTED_CODEX_CLI_VERSION),
		// Missing is the legacy write-mode encoding and must remain absent when rehashed.
		workspace_access: z.enum(["read", "write"]).optional(),
		workspace: z
			.object({
				repository_url: z.string().min(1).max(2_048),
				base_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
				reachable_from_ref: z.string().min(1).max(1_024),
				root: boundPathSchema,
				git_directory: boundPathSchema,
			})
			.strict(),
		launcher: z
			.object({
				executable: boundPathSchema,
				executable_sha256: sha256Schema,
				read_root: boundPathSchema,
				sandbox_helper: z
					.object({
						executable: boundPathSchema,
						executable_sha256: sha256Schema,
					})
					.strict(),
				config_path: localPathSchema,
				config_sha256: sha256Schema,
			})
			.strict(),
		provider: z
			.object({
				executable: boundPathSchema,
				executable_sha256: sha256Schema,
				read_root: boundPathSchema,
			})
			.strict(),
		probe: z
			.object({
				executable: boundPathSchema,
				executable_sha256: sha256Schema,
				read_root: boundPathSchema,
			})
			.strict(),
		private_paths: z
			.object({
				control_root: boundPathSchema,
				launcher_home: boundPathSchema,
				runtime_root: boundPathSchema,
				runtime_home: boundPathSchema,
				runtime_tmp: boundPathSchema,
			})
			.strict(),
		read_only_roots: z.array(boundPathSchema).max(64),
		denied_roots: z.array(boundPathSchema).min(1).max(64),
		policy_grant_sha256: sha256Schema,
	})
	.strict();

export const runtimeContainmentManifestSchema = z
	.object({
		schema_version: z.literal(1),
		instance_id: z.string().uuid(),
		created_at: z.string().datetime({ offset: true }),
		retention: z.literal("retain_for_review"),
		binding_sha256: sha256Schema,
		binding: runtimeContainmentBindingSchema,
	})
	.strict();

export type RuntimeContainmentBinding = z.infer<typeof runtimeContainmentBindingSchema>;
export type RuntimeContainmentManifest = z.infer<typeof runtimeContainmentManifestSchema>;

export interface RuntimeContainmentEvidence {
	readonly instanceId: string;
	readonly backend: typeof RUNTIME_CONTAINMENT_BACKEND;
	readonly runtimeVersion: typeof SUPPORTED_CODEX_CLI_VERSION;
	readonly baseCommit: string;
	readonly bindingSha256: string;
	readonly retention: "retain_for_review";
}

export async function createRuntimeContainmentManifest(
	path: string,
	bindingValue: RuntimeContainmentBinding,
	now: () => Date = () => new Date(),
): Promise<RuntimeContainmentManifest> {
	const binding = runtimeContainmentBindingSchema.parse(bindingValue);
	const bindingSha256 = digestCanonicalJson(binding);
	const manifest = runtimeContainmentManifestSchema.parse({
		schema_version: 1,
		instance_id: randomUUID(),
		created_at: now().toISOString(),
		retention: "retain_for_review",
		binding_sha256: bindingSha256,
		binding,
	});
	await publishPrivateJsonExclusive(path, manifest);
	return openRuntimeContainmentManifest(path, binding);
}

export async function openRuntimeContainmentManifest(
	path: string,
	bindingValue: RuntimeContainmentBinding,
): Promise<RuntimeContainmentManifest> {
	const binding = runtimeContainmentBindingSchema.parse(bindingValue);
	const bindingSha256 = digestCanonicalJson(binding);
	const manifest = await readRuntimeContainmentManifest(path);
	if (manifest.binding_sha256 !== bindingSha256 || !isDeepStrictEqual(manifest.binding, binding)) {
		throw new Error("Containment manifest does not authorize this exact workspace and policy");
	}
	return manifest;
}

export async function readRuntimeContainmentManifest(
	path: string,
): Promise<RuntimeContainmentManifest> {
	const decoded = await readPrivateJsonIfPresent(path);
	if (decoded === null) throw new Error("Containment manifest is missing");
	const manifest = runtimeContainmentManifestSchema.parse(decoded);
	assertValidManifestDigest(manifest);
	return manifest;
}

export function containmentEvidence(
	manifest: RuntimeContainmentManifest,
): RuntimeContainmentEvidence {
	return Object.freeze({
		instanceId: manifest.instance_id,
		backend: manifest.binding.backend,
		runtimeVersion: manifest.binding.runtime_version,
		baseCommit: manifest.binding.workspace.base_commit,
		bindingSha256: manifest.binding_sha256,
		retention: manifest.retention,
	});
}

export function boundPath(path: string, identity: LocalFilesystemIdentity) {
	return boundPathSchema.parse({ path, identity });
}

export function workspaceBinding(workspace: PreparedMissionWorkspace) {
	return {
		repository_url: workspace.repositoryUrl,
		base_commit: workspace.baseCommit,
		reachable_from_ref: workspace.reachableFromRef,
		root: boundPath(workspace.root, workspace.rootIdentity),
		git_directory: boundPath(workspace.gitDirectory, workspace.gitIdentity),
	};
}

function assertValidManifestDigest(manifest: RuntimeContainmentManifest): void {
	if (manifest.binding_sha256 !== digestCanonicalJson(manifest.binding)) {
		throw new Error("Containment manifest binding digest is invalid");
	}
}
