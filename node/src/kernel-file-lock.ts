import { createRequire } from "node:module";

export interface KernelFileLock {
	tryLock(fileDescriptor: number): boolean;
	unlock(fileDescriptor: number): void;
}

interface NativeFileLockModule {
	tryLock(fileDescriptor: number): boolean;
	unlock(fileDescriptor: number): void;
}

let nativeFileLock: NativeFileLockModule | undefined;

export const kernelFileLock: KernelFileLock = Object.freeze({
	tryLock(fileDescriptor: number): boolean {
		return loadNativeFileLock().tryLock(fileDescriptor);
	},
	unlock(fileDescriptor: number): void {
		loadNativeFileLock().unlock(fileDescriptor);
	},
});

function loadNativeFileLock(): NativeFileLockModule {
	if (nativeFileLock !== undefined) return nativeFileLock;
	const loaded = createRequire(import.meta.url)(
		"fs-native-extensions",
	) as Partial<NativeFileLockModule>;
	if (typeof loaded.tryLock !== "function" || typeof loaded.unlock !== "function") {
		throw new TypeError("fs-native-extensions does not expose the required lock operations");
	}
	nativeFileLock = loaded as NativeFileLockModule;
	return nativeFileLock;
}
