/*
 * Embeddable gallery. Put this where the gallery should appear:
 *   <script src="https://YOUR-PORTAL/embed.js" data-event="your-event-slug" async></script>
 * Optional: data-track="Track name" shows one track.
 * It adds an iframe of YOUR-PORTAL/embed/<event> that grows to fit its content.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  var event = script.getAttribute("data-event");
  if (!event) return;
  var track = script.getAttribute("data-track");
  var frame = document.createElement("iframe");
  frame.src = origin + "/embed/" + encodeURIComponent(event) + (track ? "?track=" + encodeURIComponent(track) : "");
  frame.title = "Hackathon projects";
  frame.loading = "lazy";
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.minHeight = "320px";
  script.parentNode.insertBefore(frame, script.nextSibling);
  window.addEventListener("message", function (e) {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    if (e.data && e.data.type === "dogfood-embed-height" && typeof e.data.height === "number") {
      frame.style.height = Math.ceil(e.data.height) + "px";
    }
  });
})();
