import { isAbsolute, relative, sep } from "node:path";

/** Component-aware containment check for canonical filesystem paths. */
export function isPathWithin(path: string, root: string): boolean {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
