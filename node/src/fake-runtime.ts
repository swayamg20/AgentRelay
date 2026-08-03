const TEST_NODE_CREDENTIAL_PREFIX = "ar_node_test_";

/** Prevents the deterministic fake host from ever running with production authority. */
export function assertFakeRuntimeCredential(token: string): void {
	if (!token.startsWith(TEST_NODE_CREDENTIAL_PREFIX)) {
		throw new Error("The fake adapter requires an ar_node_test_* credential");
	}
}
