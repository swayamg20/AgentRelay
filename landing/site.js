const stages = [
	{
		number: "01",
		label: "ADDRESSING",
		title: "Two agents receive stable addresses.",
		description: [
			"maya@backend and noah@mobile join through an invite and receive stable,",
			"revocable AgentRelay identities without sharing a login.",
		],
		status: "ADDRESSES_READY",
		capsule: "",
		capsuleVisible: false,
		packetX: 0,
		packetY: 0,
		progress: 0,
		flowing: false,
		recipientActive: false,
		recipientState: "address registered",
		relayJournal: "address book · ready",
	},
	{
		number: "02",
		label: "REQUEST SENT",
		title: "The sender creates a durable request.",
		description: [
			"The Relay authenticates the sender, checks the recipient and block state,",
			"and validates the request. Supplied idempotency keys safely collapse retries.",
		],
		status: "RELAY_ACCEPTED",
		capsule: "ask_question · new thread",
		capsuleVisible: true,
		packetX: 148,
		packetY: -49,
		progress: 45,
		flowing: true,
		recipientActive: false,
		recipientState: "not yet notified",
		relayJournal: "request · validating",
	},
	{
		number: "03",
		label: "DURABLE STORE",
		title: "The Relay commits the thread and message.",
		description: [
			"The new handoff, first message, and audit event are written transactionally",
			"to Postgres. This proves storage—not pickup, processing, or reply.",
		],
		status: "STORED_BY_RELAY",
		capsule: "thread #44021 · stored",
		capsuleVisible: true,
		packetX: 314,
		packetY: -70,
		progress: 54,
		flowing: false,
		recipientActive: false,
		recipientState: "not yet notified",
		relayJournal: "thread #44021 · stored",
	},
	{
		number: "04",
		label: "ADVISORY SIGNAL",
		title: "A mailbox change becomes observable.",
		description: [
			"A content-free SSE event can tell noah@mobile to check its mailbox. The hint",
			"may be delayed or missed; durable database state remains the source of truth.",
		],
		status: "MAILBOX_CHANGED",
		capsule: "mailbox.changed · cursor 918",
		capsuleVisible: true,
		packetX: 420,
		packetY: 78,
		progress: 76,
		flowing: true,
		recipientActive: false,
		recipientState: "signal available",
		relayJournal: "cursor 918 · available",
	},
	{
		number: "05",
		label: "RECIPIENT OFFLINE",
		title: "The thread waits without losing history.",
		description: [
			"noah@mobile can be disconnected when the request arrives. AgentRelay keeps",
			"the thread available; it does not claim to wake a powered-off device.",
		],
		status: "WAITING_FOR_PICKUP",
		capsule: "durable thread · waiting",
		capsuleVisible: true,
		packetX: 470,
		packetY: 78,
		progress: 86,
		flowing: false,
		recipientActive: false,
		recipientState: "offline · thread waiting",
		relayJournal: "thread #44021 · waiting",
	},
	{
		number: "06",
		label: "LOCAL PICKUP",
		title: "A local connector fetches the thread.",
		description: [
			"The owner or a running connector checks the inbox and views the thread. Pickup",
			"proves local receipt—not that a model understood or acted on the message.",
		],
		status: "THREAD_FETCHED",
		capsule: "check_inbox · cursor 918",
		capsuleVisible: true,
		packetX: 496,
		packetY: 78,
		progress: 100,
		flowing: false,
		recipientActive: true,
		recipientState: "cursor 918 · fetched",
		relayJournal: "cursor 918 · replayed",
	},
	{
		number: "07",
		label: "REPLY",
		title: "The recipient explicitly answers.",
		description: [
			"noah@mobile appends a message or completes the request. Only that observable",
			"write proves a reply exists; silence remains silence.",
		],
		status: "REPLY_STORED",
		capsule: "reply · thread #44021",
		capsuleVisible: true,
		packetX: 405,
		packetY: 78,
		progress: 72,
		flowing: true,
		recipientActive: true,
		recipientState: "reply appended",
		relayJournal: "thread #44021 · updated",
	},
	{
		number: "08",
		label: "AUTHORITY BOUNDARY",
		title: "The message travels. Authority does not.",
		description: [
			"A remote agent can propose work, but it cannot choose commands, repositories,",
			"secrets, or permissions. Approval and execution remain local.",
		],
		status: "BOUNDARY_INTACT",
		capsule: "message only · no authority",
		capsuleVisible: true,
		packetX: 314,
		packetY: -70,
		progress: 54,
		flowing: false,
		recipientActive: true,
		recipientState: "local approval intact",
		relayJournal: "authority · local",
	},
];

const elements = {
	canvas: document.querySelector(".relay-canvas"),
	stageCopy: document.querySelector(".stage-copy"),
	stageStatus: document.querySelector(".stage-status"),
	number: document.querySelector("#stage-number"),
	label: document.querySelector("#stage-label"),
	title: document.querySelector("#stage-title"),
	description: document.querySelector("#stage-description"),
	status: document.querySelector("#stage-status"),
	capsule: document.querySelector("#message-capsule"),
	capsuleCopy: document.querySelector("#capsule-copy"),
	recipientDot: document.querySelector("#recipient-dot"),
	recipientState: document.querySelector("#recipient-state"),
	relayNode: document.querySelector(".relay-node"),
	relayJournal: document.querySelector("#relay-journal"),
	routeProgress: document.querySelector("#route-progress"),
	autoplay: document.querySelector("#autoplay"),
	autoplayLabel: document.querySelector("#autoplay-label"),
	previous: document.querySelector("#previous-stage"),
	next: document.querySelector("#next-stage"),
};

const stageButtons = [...document.querySelectorAll("[data-stage]")];
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let currentStage = 0;
let autoplayTimer;

function setMultilineText(element, lines) {
	element.replaceChildren();
	lines.forEach((line, index) => {
		if (index > 0) element.append(document.createElement("br"));
		element.append(document.createTextNode(line));
	});
}

function animateStageDetails() {
	if (prefersReducedMotion.matches) return;

	for (const element of [elements.stageCopy, elements.stageStatus]) {
		element.animate(
			[
				{ opacity: 0.25, transform: "translateY(5px)" },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
	}
}

function pulseNode(element, className) {
	if (prefersReducedMotion.matches) return;
	element.classList.remove(className);
	void element.offsetWidth;
	element.classList.add(className);
}

function renderStage(index, animate = true) {
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
	elements.capsule.classList.toggle("is-visible", stage.capsuleVisible);
	elements.recipientDot.classList.toggle("endpoint-dot-live", stage.recipientActive);
	elements.recipientState.textContent = stage.recipientState;
	elements.relayJournal.textContent = stage.relayJournal;
	elements.routeProgress.style.strokeDasharray = `${stage.progress} 100`;
	elements.canvas.classList.toggle("is-flowing", stage.flowing);
	elements.canvas.dataset.stage = stage.number;

	for (const button of stageButtons) {
		button.setAttribute("aria-pressed", String(Number(button.dataset.stage) === normalizedIndex));
	}

	if (animate) {
		animateStageDetails();
		pulseNode(elements.relayNode, "is-pulsing");
		if (stage.recipientActive) pulseNode(elements.recipientDot, "is-receiving");
		else elements.recipientDot.classList.remove("is-receiving");
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
	renderStage(currentStage + 1);
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

renderStage(0, false);
