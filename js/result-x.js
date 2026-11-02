// Lampyva — a "✕ Remove" button on each finished result, so one image can be removed
// without clearing all the others.
export function addRemove(li, onRemove) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-sm btn-ghost res-x";
  b.setAttribute("aria-label", "Remove");
  b.innerHTML = '<span aria-hidden="true">✕</span> <span>Remove</span>';
  b.addEventListener("click", onRemove);
  (li.querySelector(".pod-meta") || li).appendChild(b);
}

/**
 * Remove one result: its row, its file in memory, and the original from the list above
 * when none of its results are left. `ui` = { state, renderFiles, clearResults, list, zip, status, onEmpty? }.
 */
export function removeResult(ui, r, li) {
  li.remove();
  if (r.url) URL.revokeObjectURL(r.url);
  const k = ui.state.results.indexOf(r);
  if (k >= 0) ui.state.results.splice(k, 1);
  if (r.file && !ui.state.results.some((x) => x.file === r.file)) {
    const j = ui.state.files.indexOf(r.file);
    if (j >= 0) { ui.state.files.splice(j, 1); ui.renderFiles(); }
  }
  if (r.compared && ui.compare) ui.compare.hidden = true;
  const extra = ui.extra ? ui.extra() : 0;
  if (ui.zip) ui.zip.hidden = ui.state.results.length + extra < 2;
  if (!ui.list.children.length) {
    ui.clearResults();
    if (ui.status) ui.status.textContent = "";
  }
}
