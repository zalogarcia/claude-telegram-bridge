/* Copy-to-clipboard for the command chips. Nothing else runs on this page. */
(function () {
  "use strict";

  function textOf(host) {
    var code = host.querySelector("code");
    return code ? code.textContent.trim() : "";
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function flash(btn, label) {
    btn.textContent = label;
    btn.setAttribute("data-done", "1");
    window.setTimeout(function () {
      btn.textContent = "Copy";
      btn.removeAttribute("data-done");
    }, 1600);
  }

  function wire(btn) {
    var host = btn.closest("[data-copy]");
    if (!host) return;

    btn.addEventListener("click", function () {
      var text = textOf(host);
      if (!text) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            flash(btn, "Copied");
          },
          function () {
            flash(btn, legacyCopy(text) ? "Copied" : "Copy failed");
          },
        );
        return;
      }

      flash(btn, legacyCopy(text) ? "Copied" : "Copy failed");
    });
  }

  var buttons = document.querySelectorAll("[data-copy-btn]");
  for (var i = 0; i < buttons.length; i++) wire(buttons[i]);
})();
