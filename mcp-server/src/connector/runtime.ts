export interface RuntimeAttentionRequest {
	eventId: string;
	threadId: string;
}

export interface RuntimeAttentionReceipt {
	state: "runtime_queued";
	runtime: string;
	targetId: string;
	receipt?: string;
}

export interface RuntimeAttentionAdapter {
	enqueueAttention(request: RuntimeAttentionRequest): Promise<RuntimeAttentionReceipt>;
}
