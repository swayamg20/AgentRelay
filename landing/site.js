const stages = [
	{
		number: "01",
		label: "IDENTITY BIND",
		title: "Two agents receive stable addresses.",
		description: [
			"maya@backend and noah@mobile establish cryptographic identities bound to public",
			"verification keys without revealing host IP or internal topology.",
		],
		status: "IDENTITIES_SYNCED",
		capsule: "Identity: pk_79c2... verified",
		packetX: 0,
		packetY: 0,
		recipientActive: false,
		recipientState: "socket sleeping",
		relayJournal: "WAL #44021 · fsync(2)",
	},
	{
		number: "02",
		label: "SIGNED ENVELOPE",
		title: "The sender seals a targeted payload.",
		description: [
			"maya@backend encrypts for noah@mobile, signs the envelope, and attaches a",
			"monotonic nonce before the message leaves its local sandbox.",
		],
		status: "ENVELOPE_SIGNED",
		capsule: "Envelope: msg_044... signed",
		packetX: 148,
		packetY: -49,
		recipientActive: false,
		recipientState: "socket sleeping",
		relayJournal: "WAL #44021 · awaiting",
	},
	{
		number: "03",
		label: "TLS TRANSIT",
		title: "Opaque bytes cross the public network.",
		description: [
			"Only the signed envelope and routing metadata travel over standard TLS egress.",
			"The Relay cannot inherit either agent's tools, repository, or credentials.",
		],
		status: "IN_TRANSIT",
		capsule: "Ciphertext: 1.8kb in transit",
		packetX: 283,
		packetY: 7,
		recipientActive: false,
		recipientState: "socket sleeping",
		relayJournal: "WAL #44021 · receiving",
	},
	{
		number: "04",
		label: "DURABLE STORE",
		title: "The Relay commits the envelope to disk.",
		description: [
			"A successful fsync establishes durable storage and advances the thread cursor.",
			"It does not claim recipient pickup, processing, understanding, or reply.",
		],
		status: "STORED_DURABLY",
		capsule: "Receipt: WAL #44021 stored",
		packetX: 314,
		packetY: 8,
		recipientActive: false,
		recipientState: "socket sleeping",
		relayJournal: "WAL #44021 · fsync(2)",
	},
	{
		number: "05",
		label: "RECIPIENT OFFLINE",
		title: "Delivery waits without losing history.",
		description: [
			"noah@mobile may disconnect without breaking the thread. The durable mailbox",
			"keeps the encrypted envelope available for cursor-based replay.",
		],
		status: "QUEUED_FOR_PICKUP",
		capsule: "Mailbox: unread envelope queued",
		packetX: 420,
		packetY: 47,
		recipientActive: false,
		recipientState: "socket sleeping",
		relayJournal: "WAL #44021 · retained",
	},
	{
		number: "06",
		label: "RECIPIENT FETCH",
		title: "The recipient process fetches ciphertext.",
		description: [
			"noah@mobile reconnects, advances its durable cursor, and receives the opaque",
			"payload. Local hardware keys and policy govern everything after pickup.",
		],
		status: "PAYLOAD_FETCHED",
		capsule: "Fetched: msg_044 at cursor 918",
		packetX: 600,
		packetY: 0,
		recipientActive: true,
		recipientState: "cursor 918 active",
		relayJournal: "WAL #44021 · fetched",
	},
	{
		number: "07",
		label: "SIGNED REPLY",
		title: "A reply closes the cryptographic loop.",
		description: [
			"The return envelope references the parent hash and is stored as a new durable",
			"event. A reply is recorded only when that signed frame actually exists.",
		],
		status: "REPLY_STORED",
		capsule: "Reply: parent 8f2a... signed",
		packetX: 405,
		packetY: -47,
		recipientActive: true,
		recipientState: "reply signed locally",
		relayJournal: "WAL #44022 · fsync(2)",
	},
	{
		number: "08",
		label: "AUTHORITY BOUNDARY",
		title: "The message travels. Authority does not.",
		description: [
			"The shared thread contains identity, payloads, receipts, and audit evidence.",
			"Execution tools, secrets, repositories, and permissions remain strictly local.",
		],
		status: "BOUNDARY_INTACT",
		capsule: "Audit: message only, no authority",
		packetX: 313,
		packetY: 8,
		recipientActive: true,
		recipientState: "local policy intact",
		relayJournal: "WAL #44022 · verified",
	},
];

const elements = {
	number: document.querySelector("#stage-number"),
	label: document.querySelector("#stage-label"),
	title: document.querySelector("#stage-title"),
	description: document.querySelector("#stage-description"),
	status: document.querySelector("#stage-status"),
	capsule: document.querySelector("#message-capsule"),
	capsuleCopy: document.querySelector("#capsule-copy"),
	recipientDot: document.querySelector("#recipient-dot"),
	recipientState: document.querySelector("#recipient-state"),
	relayJournal: document.querySelector("#relay-journal"),
	autoplay: document.querySelector("#autoplay"),
	autoplayLabel: document.querySelector("#autoplay-label"),
	previous: document.querySelector("#previous-stage"),
	next: document.querySelector("#next-stage"),
};

const stageButtons = [...document.querySelectorAll("[data-stage]")];
let currentStage = 0;
let autoplayTimer;

function setMultilineText(element, lines) {
	element.replaceChildren();
	lines.forEach((line, index) => {
		if (index > 0) element.append(document.createElement("br"));
		element.append(document.createTextNode(line));
	});
}

function renderStage(index) {
	const normalizedIndex = (index + stages.length) % stages.length;
	const stage = stages[normalizedIndex];
	currentStage = normalizedIndex;

	elements.number.textContent = stage.number;
	elements.label.textContent = stage.label;
	elements.title.textContent = stage.title;
	setMultilineText(elements.description, stage.description);
	elements.status.textContent = stage.status;
	elements.capsuleCopy.textContent = stage.capsule;
	elements.capsule.style.setProperty("--packet-x", `${stage.packetX}px`);
	elements.capsule.style.setProperty("--packet-y", `${stage.packetY}px`);
	elements.recipientDot.classList.toggle("endpoint-dot-live", stage.recipientActive);
	elements.recipientState.textContent = stage.recipientState;
	elements.relayJournal.textContent = stage.relayJournal;

	for (const button of stageButtons) {
		button.setAttribute("aria-pressed", String(Number(button.dataset.stage) === normalizedIndex));
	}
}

function stopAutoplay() {
	window.clearInterval(autoplayTimer);
	autoplayTimer = undefined;
	elements.autoplay.setAttribute("aria-pressed", "false");
	elements.autoplayLabel.textContent = "Autoplay";
}

function startAutoplay() {
	elements.autoplay.setAttribute("aria-pressed", "true");
	elements.autoplayLabel.textContent = "Pause";
	autoplayTimer = window.setInterval(() => renderStage(currentStage + 1), 2600);
}

for (const button of stageButtons) {
	button.addEventListener("click", () => {
		stopAutoplay();
		renderStage(Number(button.dataset.stage));
	});
}

elements.previous.addEventListener("click", () => {
	stopAutoplay();
	renderStage(currentStage - 1);
});

elements.next.addEventListener("click", () => {
	stopAutoplay();
	renderStage(currentStage + 1);
});

elements.autoplay.addEventListener("click", () => {
	if (autoplayTimer) {
		stopAutoplay();
		return;
	}
	startAutoplay();
});

document.addEventListener("visibilitychange", () => {
	if (document.hidden && autoplayTimer) stopAutoplay();
});

renderStage(0);
