const scenes = [
	{
		state: "Negotiating",
		time: "09:42:16",
		direction: "backend → android",
		message:
			"The API now supports partial refunds. Which fields does the Android model still need?",
		artifactType: "API contract",
		artifact: "openapi/refunds.yaml",
		proof: "schema diff attached",
	},
	{
		state: "Revision 02",
		time: "09:43:18",
		direction: "android → backend",
		message:
			"Make failureReason nullable and keep UNKNOWN for older app versions. Then the client contract is safe.",
		artifactType: "Proposal",
		artifact: "refund-contract.v2",
		proof: "revision acknowledged by both sides",
	},
	{
		state: "Working locally",
		time: "09:48:44",
		direction: "both workspaces",
		message:
			"Each agent applies the accepted contract inside its own repository and returns bounded progress evidence.",
		artifactType: "Local result",
		artifact: "backend:34/34 · android:18/18",
		proof: "repositories never crossed the Relay",
	},
	{
		state: "Ready for review",
		time: "09:55:51",
		direction: "mission → owners",
		message:
			"The contract, implementations, and user scenario agree. The remaining decision belongs to the humans: ship or revise.",
		artifactType: "Evidence",
		artifact: "mission-result.json",
		proof: "compatible changes · replayable trace",
	},
];

const dispatchFields = {
	state: document.querySelector("#dispatch-state"),
	time: document.querySelector("#dispatch-time"),
	direction: document.querySelector("#dispatch-direction"),
	message: document.querySelector("#dispatch-message"),
	artifactType: document.querySelector("#dispatch-artifact-type"),
	artifact: document.querySelector("#dispatch-artifact"),
	proof: document.querySelector("#dispatch-proof"),
};

const sceneButtons = [...document.querySelectorAll("[data-scene]")];

function showScene(index) {
	const scene = scenes[index];
	if (!scene) return;

	for (const [name, element] of Object.entries(dispatchFields)) {
		element.textContent = scene[name];
	}

	for (const button of sceneButtons) {
		button.setAttribute("aria-pressed", String(Number(button.dataset.scene) === index));
	}
}

for (const button of sceneButtons) {
	button.addEventListener("click", () => showScene(Number(button.dataset.scene)));
}

const copyStatus = document.querySelector("#copy-status");
let copyStatusTimer;

function announceCopyStatus(message) {
	window.clearTimeout(copyStatusTimer);
	copyStatus.textContent = message;
	copyStatus.dataset.visible = "true";
	copyStatusTimer = window.setTimeout(() => {
		copyStatus.dataset.visible = "false";
	}, 2400);
}

function selectText(element) {
	const selection = window.getSelection();
	const range = document.createRange();
	range.selectNodeContents(element);
	selection.removeAllRanges();
	selection.addRange(range);
}

for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		const target = document.getElementById(button.dataset.copy);
		const text = target?.innerText.trim();
		if (!target || !text) return;

		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
			announceCopyStatus("Command copied to clipboard.");
			window.setTimeout(() => {
				button.textContent = "Copy";
			}, 1800);
		} catch {
			selectText(target);
			announceCopyStatus("Clipboard access was unavailable. The command is selected for you.");
		}
	});
}
