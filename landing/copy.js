const copyTimers = new WeakMap();

async function writeClipboard(text) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("Copy command was not available");
}

for (const button of document.querySelectorAll("[data-copy-target]")) {
	button.addEventListener("click", async () => {
		const target = document.querySelector(button.dataset.copyTarget);
		const label = button.querySelector(".copy-label");
		if (!target || !label) return;

		window.clearTimeout(copyTimers.get(button));

		try {
			await writeClipboard(target.textContent.trim());
			button.dataset.copyState = "success";
			label.textContent = "Copied";
		} catch {
			button.dataset.copyState = "error";
			label.textContent = "Try again";
		}

		copyTimers.set(
			button,
			window.setTimeout(() => {
				delete button.dataset.copyState;
				label.textContent = "Copy";
			}, 1600),
		);
	});
}
