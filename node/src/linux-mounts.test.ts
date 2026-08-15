import { describe, expect, it } from "vitest";
import {
	assertNoLinuxStorageAliases,
	assertNoNestedLinuxMounts,
	hasNestedLinuxMount,
	parseLinuxMounts,
} from "./linux-mounts.js";

const MOUNT_INFO = [
	"29 1 8:1 / / rw,relatime - ext4 /dev/root rw",
	"30 29 8:1 /workspace /opt rw,relatime - none /workspace rw",
	"31 29 8:2 / /separate rw,relatime - ext4 /dev/other rw",
].join("\n");

describe("Linux mount provenance", () => {
	it("detects aliases through a bind-mounted ancestor", () => {
		const mounts = parseLinuxMounts(MOUNT_INFO);

		expect(() =>
			assertNoLinuxStorageAliases(
				[
					{ path: "/workspace/trusted", access: "write" },
					{ path: "/opt/trusted", access: "read" },
				],
				mounts,
			),
		).toThrow("cannot alias storage");
	});

	it("keeps distinct storage and intentional namespace carve-outs valid", () => {
		const mounts = parseLinuxMounts(MOUNT_INFO);

		expect(() =>
			assertNoLinuxStorageAliases(
				[
					{ path: "/workspace", access: "write" },
					{ path: "/workspace/.git", access: "deny" },
					{ path: "/separate/runtime", access: "read" },
				],
				mounts,
			),
		).not.toThrow();
	});

	it("recognizes dot-dot-prefixed child mount names", () => {
		const mounts = parseLinuxMounts(
			`${MOUNT_INFO}\n32 29 8:3 / /workspace/..mounted-secret rw - ext4 /dev/third rw`,
		);

		expect(hasNestedLinuxMount(mounts, "/workspace")).toBe(true);
	});

	it("rejects a nested mount under any writable runtime root", () => {
		const mounts = parseLinuxMounts(
			`${MOUNT_INFO}\n33 29 8:4 /secrets /runtime/tmp/secret rw - none /secrets rw`,
		);

		expect(() =>
			assertNoNestedLinuxMounts(["/workspace", "/runtime/home", "/runtime/tmp"], mounts),
		).toThrow("writable roots cannot contain nested mounts");
		expect(() => assertNoNestedLinuxMounts(["/runtime/home"], mounts)).not.toThrow();
	});
});
