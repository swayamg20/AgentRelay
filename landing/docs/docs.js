document.documentElement.classList.add("has-js");

const links = [...document.querySelectorAll("[data-doc-link]")];
const sections = links
	.map((link) => document.querySelector(link.getAttribute("href")))
	.filter(Boolean);
const progress = document.querySelector("#reading-progress");

function selectSection(id) {
	for (const link of links) {
		const active = link.getAttribute("href") === `#${id}`;
		if (active) link.setAttribute("aria-current", "location");
		else link.removeAttribute("aria-current");
	}
}

const sectionObserver = new IntersectionObserver(
	(entries) => {
		const visible = entries
			.filter((entry) => entry.isIntersecting)
			.sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
		if (visible[0]) selectSection(visible[0].target.id);
	},
	{ rootMargin: "-18% 0px -68% 0px", threshold: 0 },
);

const revealObserver = new IntersectionObserver(
	(entries, observer) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			entry.target.classList.add("is-visible");
			observer.unobserve(entry.target);
		}
	},
	{ rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
);

for (const section of sections) {
	sectionObserver.observe(section);
	if (!section.classList.contains("is-visible")) revealObserver.observe(section);
}

const initialSection = document.querySelector(window.location.hash || "#overview");
if (initialSection?.matches("[data-doc-section]")) {
	initialSection.classList.add("is-visible");
	selectSection(initialSection.id);
} else {
	selectSection("overview");
}

let progressFrame;
function updateProgress() {
	progressFrame = undefined;
	if (!progress) return;
	const available = document.documentElement.scrollHeight - window.innerHeight;
	const value = available > 0 ? Math.min(1, Math.max(0, window.scrollY / available)) : 0;
	progress.style.transform = `scaleY(${value})`;
}

window.addEventListener(
	"scroll",
	() => {
		if (progressFrame) return;
		progressFrame = window.requestAnimationFrame(updateProgress);
	},
	{ passive: true },
);

updateProgress();
