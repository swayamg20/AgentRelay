const scenes = [
	{
		state: "Stored",
		time: "09:42:16",
		direction: "backend → android",
		message:
			"The API now supports partial refunds. Which fields does the Android model still need?",
		artifactType: "Request",
		artifact: "ask_question · pending",
		proof: "durably stored by the Relay",
	},
	{
		state: "Inbox fetched",
		time: "09:42:41",
		direction: "relay → android",
		message: "The recipient's running agent checks the inbox and sees the pending request.",
		artifactType: "Pickup",
		artifact: "thread reference",
		proof: "fetched by the participant",
	},
	{
		state: "Accepted",
		time: "09:43:02",
		direction: "android → relay",
		message: "The receiving owner accepts the request inside their normal local approval boundary.",
		artifactType: "Thread state",
		artifact: "pending → accepted",
		proof: "explicit lifecycle transition",
	},
	{
		state: "Reply received",
		time: "09:44:18",
		direction: "android → backend",
		message:
			"Make failureReason nullable and keep UNKNOWN for older app versions. Then the client contract is safe.",
		artifactType: "Reply",
		artifact: "message appended",
		proof: "explicit response on the durable thread",
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
