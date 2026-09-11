// Runs before React, so the page never flashes the wrong theme. An external
// file rather than an inline <script>: the server's CSP forbids inline script.
(function () {
  try {
    var pref = localStorage.getItem("theme") || "system";
    var dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    var locale = localStorage.getItem("locale");
    if (locale) document.documentElement.lang = locale;
  } catch (e) { /* storage blocked: fall back to light */ }
})();
