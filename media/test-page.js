/* global initButton */
let args = new URLSearchParams(typeof window.__queryString === "string" ? window.__queryString : window.location.search.slice(1));
let sfHost = args.get("host");
initButton(sfHost, true);
addEventListener("message", e => {
  if (e.data.insextLoaded) {
    parent.insextTestLoaded({getRecordId: window[0].getRecordId});
  }
});
document.querySelector(".insext-btn").click();
