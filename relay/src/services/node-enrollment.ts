import { isDeepStrictEqual } from "node:util";
import {
	type IssuedNodeCredential,
	type NodeCredentialRotationInput,
	type NodeDescriptor,
	type NodeEnrollmentInput,
	type OwnedNodeSummary,
	type WorkspaceBindingDescriptor,
	type WorkspaceRegistrationInput,
	nodeDescriptorSchema,
	ownedNodeSummarySchema,
	workspaceBindingDescriptorSchema,
} from "@agentrelay/protocol";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { generateNodeKey } from "../auth/keys.js";
import type { Database } from "../db/client.js";
import {
	type Node,
	type WorkspaceBinding,
	agents,
	nodeCredentials,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { RelayError } from "../errors.js";
import { writeAudit } from "./audit.js";
import { cancelDeliveriesForRevocation } from "./delivery-revocation.js";

export type NodeTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface MutationContext {
	requestId?: string;
}

export interface NodeCredentialContext {
	nodeId: string;
	agentId: string;
	credentialId: string;
	requestId?: string;
}

export interface EnrollNodeResult {
	node: NodeDescriptor;
	credential: IssuedNodeCredential;
}

export interface RegisterWorkspaceResult {
	workspace: WorkspaceBindingDescriptor;
	replayed: boolean;
}

export async function enrollNode(
	db: Database,
	agentId: string,
	input: NodeEnrollmentInput,
	keyEnvironment: "live" | "test",
	pepper: string,
	context: MutationContext = {},
): Promise<EnrollNodeResult> {
	const capabilities = [...input.capabilities].sort();
	const generated = generateNodeKey(keyEnvironment, pepper);

	return db.transaction(async (tx) => {
		await lockAgentLifecycle(tx, agentId);
		await lock(tx, `node-enroll:${agentId}:${input.name}`);
		const [owner] = await tx
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.status, "active")))
			.limit(1);
		if (!owner) {
			throw new RelayError("unauthenticated", "Only an active agent can enroll a Node");
		}

		const [existing] = await tx
			.select({ id: nodes.id })
			.from(nodes)
			.where(
				and(eq(nodes.agentId, agentId), eq(nodes.name, input.name), eq(nodes.status, "active")),
			)
			.limit(1);
		if (existing) {
			throw new RelayError("state_changed", "An active Node with this name already exists", {
				node_id: existing.id,
			});
		}

		const [node] = await tx
			.insert(nodes)
			.values({ agentId, name: input.name, capabilities })
			.returning();
		if (!node) throw new RelayError("internal", "Failed to enroll Node");

		const [credential] = await tx
			.insert(nodeCredentials)
			.values({
				nodeId: node.id,
				keyHash: generated.hash,
				salt: generated.salt,
				label: "enrollment",
			})
			.returning({ id: nodeCredentials.id });
		if (!credential) throw new RelayError("internal", "Failed to issue Node credential");

		await writeAudit(tx, {
			actorId: agentId,
			action: "node.enroll",
			resourceType: "node",
			resourceId: node.id,
			requestId: context.requestId,
			metadata: {
				credential_id: credential.id,
				name: node.name,
				capabilities,
			},
		});

		return {
			node: toNodeDescriptor(node),
			credential: { id: credential.id, token: generated.raw },
		};
	});
}

export async function listNodes(db: Database, agentId: string): Promise<OwnedNodeSummary[]> {
	const rows = await db
		.select({ node: nodes, activeCredentialId: nodeCredentials.id })
		.from(nodes)
		.leftJoin(
			nodeCredentials,
			and(eq(nodeCredentials.nodeId, nodes.id), isNull(nodeCredentials.revokedAt)),
		)
		.where(eq(nodes.agentId, agentId))
		.orderBy(asc(nodes.createdAt), asc(nodes.id));
	const seenNodeIds = new Set<string>();
	return rows.map((row) => {
		if (seenNodeIds.has(row.node.id)) {
			throw new RelayError("internal", "Node has multiple active credentials");
		}
		seenNodeIds.add(row.node.id);
		return ownedNodeSummarySchema.parse({
			node: toNodeDescriptor(row.node),
			active_credential_id: row.activeCredentialId,
		});
	});
}

export async function getNode(
	db: Database,
	nodeId: string,
	agentId: string,
): Promise<NodeDescriptor> {
	const [node] = await db
		.select()
		.from(nodes)
		.where(and(eq(nodes.id, nodeId), eq(nodes.agentId, agentId)))
		.limit(1);
	if (!node) throw new RelayError("node_not_found", "Node not found");
	return toNodeDescriptor(node);
}

export async function rotateNodeCredential(
	db: Database,
	agentId: string,
	nodeId: string,
	input: NodeCredentialRotationInput,
	keyEnvironment: "live" | "test",
	pepper: string,
	context: MutationContext = {},
): Promise<IssuedNodeCredential> {
	const generated = generateNodeKey(keyEnvironment, pepper);

	return db.transaction(async (tx) => {
		await lock(tx, `node:${nodeId}`);
		const [node] = await tx
			.select({ id: nodes.id, status: nodes.status })
			.from(nodes)
			.where(and(eq(nodes.id, nodeId), eq(nodes.agentId, agentId)))
			.limit(1);
		if (!node) throw new RelayError("node_not_found", "Node not found");
		if (node.status !== "active") {
			throw new RelayError("invalid_transition", "Cannot rotate a revoked Node credential");
		}
		const activeCredentials = await loadActiveCredentialIds(tx, nodeId);
		if (
			activeCredentials.length !== 1 ||
			activeCredentials[0]?.id !== input.expected_credential_id
		) {
			throw credentialStateChanged(input.expected_credential_id, activeCredentials);
		}

		const [revoked] = await tx
			.update(nodeCredentials)
			.set({ revokedAt: sql`clock_timestamp()` })
			.where(
				and(
					eq(nodeCredentials.id, input.expected_credential_id),
					eq(nodeCredentials.nodeId, nodeId),
					isNull(nodeCredentials.revokedAt),
				),
			)
			.returning({ id: nodeCredentials.id });
		if (!revoked) {
			throw credentialStateChanged(
				input.expected_credential_id,
				await loadActiveCredentialIds(tx, nodeId),
			);
		}
		const [credential] = await tx
			.insert(nodeCredentials)
			.values({
				nodeId,
				keyHash: generated.hash,
				salt: generated.salt,
				label: "owner-rotated",
			})
			.returning({ id: nodeCredentials.id });
		if (!credential) throw new RelayError("internal", "Failed to issue rotated credential");

		await writeAudit(tx, {
			actorId: agentId,
			action: "node.credential.rotate",
			resourceType: "node",
			resourceId: nodeId,
			requestId: context.requestId,
			metadata: {
				previous_credential_id: revoked.id,
				credential_id: credential.id,
			},
		});

		return { id: credential.id, token: generated.raw };
	});
}

export async function revokeNode(
	db: Database,
	agentId: string,
	nodeId: string,
	context: MutationContext = {},
): Promise<void> {
	await db.transaction(async (tx) => {
		await lock(tx, `node:${nodeId}`);
		const [node] = await tx
			.select({ id: nodes.id, status: nodes.status })
			.from(nodes)
			.where(and(eq(nodes.id, nodeId), eq(nodes.agentId, agentId)))
			.limit(1);
		if (!node) throw new RelayError("node_not_found", "Node not found");
		if (node.status === "revoked") return;

		await cancelDeliveriesForRevocation(tx, {
			nodeId,
			actorId: agentId,
			requestId: context.requestId,
			scope: { reason: "node_revoked" },
		});
		await tx
			.update(nodes)
			.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
			.where(eq(nodes.id, nodeId));
		await tx
			.update(nodeCredentials)
			.set({ revokedAt: sql`clock_timestamp()` })
			.where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)));
		await tx
			.update(workspaceBindings)
			.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
			.where(and(eq(workspaceBindings.nodeId, nodeId), eq(workspaceBindings.status, "active")));

		await writeAudit(tx, {
			actorId: agentId,
			action: "node.revoke",
			resourceType: "node",
			resourceId: nodeId,
			requestId: context.requestId,
		});
	});
}

export async function registerWorkspace(
	db: Database,
	auth: NodeCredentialContext,
	input: WorkspaceRegistrationInput,
): Promise<RegisterWorkspaceResult> {
	const allowedBaseRefs = [...input.allowed_base_refs].sort();

	return db.transaction(async (tx) => {
		await lock(tx, `node:${auth.nodeId}`);
		await lock(tx, `workspace:${auth.nodeId}:${input.alias}`);
		await assertActiveNodeCredential(tx, auth);

		const [existing] = await tx
			.select()
			.from(workspaceBindings)
			.where(
				and(eq(workspaceBindings.nodeId, auth.nodeId), eq(workspaceBindings.alias, input.alias)),
			)
			.orderBy(asc(workspaceBindings.createdAt))
			.limit(1);
		if (existing) {
			if (existing.status !== "active") {
				throw new RelayError(
					"invalid_transition",
					"A revoked workspace alias cannot be registered again",
				);
			}
			if (
				existing.repositoryUrl !== input.repository_url ||
				!isDeepStrictEqual(existing.allowedBaseRefs, allowedBaseRefs)
			) {
				throw new RelayError(
					"state_changed",
					"Workspace alias is already registered with different configuration",
					{ workspace_binding_id: existing.id },
				);
			}
			return {
				workspace: toWorkspaceDescriptor(existing, auth.agentId),
				replayed: true,
			};
		}

		const [workspace] = await tx
			.insert(workspaceBindings)
			.values({
				nodeId: auth.nodeId,
				alias: input.alias,
				repositoryUrl: input.repository_url,
				allowedBaseRefs,
			})
			.returning();
		if (!workspace) throw new RelayError("internal", "Failed to register workspace");

		await writeAudit(tx, {
			actorId: auth.agentId,
			action: "workspace.register",
			resourceType: "workspace_binding",
			resourceId: workspace.id,
			requestId: auth.requestId,
			metadata: {
				node_id: auth.nodeId,
				credential_id: auth.credentialId,
				alias: workspace.alias,
			},
		});

		return {
			workspace: toWorkspaceDescriptor(workspace, auth.agentId),
			replayed: false,
		};
	});
}

export async function listWorkspaces(
	db: Database,
	nodeId: string,
	agentId: string,
): Promise<WorkspaceBindingDescriptor[]> {
	const rows = await db
		.select()
		.from(workspaceBindings)
		.where(eq(workspaceBindings.nodeId, nodeId))
		.orderBy(asc(workspaceBindings.createdAt), asc(workspaceBindings.id));
	return rows.map((row) => toWorkspaceDescriptor(row, agentId));
}

export async function revokeWorkspace(
	db: Database,
	auth: NodeCredentialContext,
	alias: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		await lock(tx, `node:${auth.nodeId}`);
		await lock(tx, `workspace:${auth.nodeId}:${alias}`);
		await assertActiveNodeCredential(tx, auth);

		const [workspace] = await tx
			.select()
			.from(workspaceBindings)
			.where(and(eq(workspaceBindings.nodeId, auth.nodeId), eq(workspaceBindings.alias, alias)))
			.orderBy(asc(workspaceBindings.createdAt))
			.limit(1);
		if (!workspace) throw new RelayError("workspace_not_found", "Workspace not found");
		if (workspace.status === "revoked") return;

		await cancelDeliveriesForRevocation(tx, {
			nodeId: auth.nodeId,
			actorId: auth.agentId,
			requestId: auth.requestId,
			scope: {
				reason: "workspace_revoked",
				workspaceBindingId: workspace.id,
			},
		});
		const [revoked] = await tx
			.update(workspaceBindings)
			.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
			.where(eq(workspaceBindings.id, workspace.id))
			.returning({ id: workspaceBindings.id });
		if (!revoked) throw new RelayError("internal", "Failed to revoke workspace");

		await writeAudit(tx, {
			actorId: auth.agentId,
			action: "workspace.revoke",
			resourceType: "workspace_binding",
			resourceId: workspace.id,
			requestId: auth.requestId,
			metadata: {
				node_id: auth.nodeId,
				credential_id: auth.credentialId,
				alias: workspace.alias,
			},
		});
	});
}

function toNodeDescriptor(node: Node): NodeDescriptor {
	return nodeDescriptorSchema.parse({
		node_id: node.id,
		agent_id: node.agentId,
		name: node.name,
		status: node.status,
		capabilities: node.capabilities,
		last_seen_at: node.lastSeenAt?.toISOString() ?? null,
		created_at: node.createdAt.toISOString(),
		updated_at: node.updatedAt.toISOString(),
		revoked_at: node.revokedAt?.toISOString() ?? null,
	});
}

function toWorkspaceDescriptor(
	workspace: WorkspaceBinding,
	agentId: string,
): WorkspaceBindingDescriptor {
	return workspaceBindingDescriptorSchema.parse({
		workspace_binding_id: workspace.id,
		node_id: workspace.nodeId,
		agent_id: agentId,
		alias: workspace.alias,
		repository_url: workspace.repositoryUrl,
		allowed_base_refs: workspace.allowedBaseRefs,
		status: workspace.status,
		created_at: workspace.createdAt.toISOString(),
		updated_at: workspace.updatedAt.toISOString(),
		revoked_at: workspace.revokedAt?.toISOString() ?? null,
	});
}

export async function assertActiveNodeCredential(
	tx: NodeTransaction,
	auth: NodeCredentialContext,
): Promise<void> {
	const [authorized] = await tx
		.select({ id: nodeCredentials.id })
		.from(nodeCredentials)
		.innerJoin(nodes, eq(nodes.id, nodeCredentials.nodeId))
		.innerJoin(agents, eq(agents.id, nodes.agentId))
		.where(
			and(
				eq(nodeCredentials.id, auth.credentialId),
				eq(nodeCredentials.nodeId, auth.nodeId),
				isNull(nodeCredentials.revokedAt),
				eq(nodes.agentId, auth.agentId),
				eq(nodes.status, "active"),
				eq(agents.status, "active"),
			),
		)
		.limit(1);
	if (!authorized) {
		throw new RelayError("unauthenticated", "Node credential no longer authorizes this operation");
	}
}

/** Serializes Node-authorized mutations with credential rotation and revocation. */
export async function lockNodeMutation(tx: NodeTransaction, nodeId: string): Promise<void> {
	await lock(tx, `node:${nodeId}`);
}

/** Serializes agent-owned authority issuance with owner disablement. */
export async function lockAgentLifecycle(tx: NodeTransaction, agentId: string): Promise<void> {
	await lock(tx, `agent-lifecycle:${agentId}`);
}

async function loadActiveCredentialIds(
	tx: NodeTransaction,
	nodeId: string,
): Promise<Array<{ id: string }>> {
	return tx
		.select({ id: nodeCredentials.id })
		.from(nodeCredentials)
		.where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)))
		.limit(2);
}

function credentialStateChanged(
	expectedCredentialId: string,
	activeCredentials: ReadonlyArray<{ id: string }>,
): RelayError {
	return new RelayError(
		"state_changed",
		"Active Node credential changed; refresh the owner Node summary",
		{
			expected_credential_id: expectedCredentialId,
			active_credential_id: activeCredentials.length === 1 ? activeCredentials[0]!.id : null,
		},
	);
}

async function lock(tx: NodeTransaction, key: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
}
