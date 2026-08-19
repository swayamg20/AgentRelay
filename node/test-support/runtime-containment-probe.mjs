import { spawn } from "node:child_process";
import { access, readFile, readlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";

const paths = JSON.parse(process.argv[2]);
const managedProxyEnvironmentPresent = Object.keys(process.env).some(
	(name) =>
		name.toUpperCase().includes("PROXY") ||
		name === "NODE_USE_ENV_PROXY" ||
		name === "ELECTRON_GET_USE_PROXY",
);

const result = {
	workspaceRead: await canRead(paths.workspaceFile),
	workspaceWrite: await canWrite(paths.workspaceWrite),
	gitMetadataWrite: await canWrite(paths.gitMetadataWrite),
	readRootRead: await canRead(paths.readRootFile),
	readRootWrite: await canWrite(paths.readRootWrite),
	siblingRead: await canRead(paths.siblingSecret),
	grandchildSiblingRead: await canGrandchildRead(paths.siblingSecret),
	siblingWrite: await canWrite(paths.siblingWrite),
	sharedTempRead: await canRead(paths.sharedTempSecret),
	sshRead: await canRead(paths.sshSecret),
	awsRead: await canRead(paths.awsSecret),
	azureRead: await canRead(paths.azureSecret),
	controlRead: await canRead(paths.controlSecret),
	launcherConfigRead: await canRead(paths.launcherConfig),
	symlinkRead: await canRead(paths.symlinkEscape),
	traversalRead: await canRead(paths.traversalEscape),
	runtimeHomeWrite: await canWrite(paths.runtimeHomeWrite),
	runtimeTmpWrite: await canWrite(paths.runtimeTmpWrite),
	environmentSecretPresent: process.env.AGENTRELAY_NODE_TOKEN !== undefined,
	managedProxyEnvironmentPresent,
	home: process.env.HOME,
	codexHome: process.env.CODEX_HOME,
	tmpdir: process.env.TMPDIR,
	networkNamespace: await readlink("/proc/self/ns/net"),
	networkConnect: await canConnect(),
};

await writeFile(paths.resultPath, JSON.stringify({ token: paths.resultToken, result }), {
	flag: "wx",
	mode: 0o600,
});

async function canRead(path) {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function canGrandchildRead(path) {
	const script = "require('node:fs').readFileSync(process.argv[1])";
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", script, path], { stdio: "ignore" });
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
}

async function canWrite(path) {
	try {
		await writeFile(path, "probe", { flag: "wx" });
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function canConnect() {
	return new Promise((resolve) => {
		const socket = connect({ host: "1.1.1.1", port: 53 });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 500);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}
