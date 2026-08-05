const copyButtons = document.querySelectorAll("[data-copy]");

async function copyText(value) {
  if(navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

for(const button of copyButtons) {
  button.addEventListener("click", async () => {
    const originalLabel = button.textContent;
    try {
      await copyText(button.dataset.copy);
      button.textContent = "Copied";
      button.dataset.copied = "true";
    } catch {
      button.textContent = "Copy failed";
    }

    window.setTimeout(() => {
      button.textContent = originalLabel;
      delete button.dataset.copied;
    }, 1600);
  });
}
