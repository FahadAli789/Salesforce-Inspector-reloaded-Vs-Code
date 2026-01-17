/* global fetch */
export function loadSymbols() {
  if (document.getElementById("svg-symbols")) {
    return;
  }
  const div = document.createElement("div");
  div.id = "svg-symbols";
  div.style.display = "none";
  // Insert at top of body to ensure it's available
  document.body.insertBefore(div, document.body.firstChild);

  // In VS Code webview, relative path should work if base is set, or just relative to the script
  fetch("symbols.svg")
    .then(response => response.text())
    .then(text => {
      div.innerHTML = text;
    })
    .catch(err => {
      console.error("Failed to load SVG symbols", err);
    });
}
