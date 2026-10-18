const DEFAULTS = {
  enabled: true,
  source: "browser",
  hideAds: true,
  hideShorts: true,
  returnDislike: true,
  sponsorBlock: true,
  sbCategories: ["sponsor", "selfpromo", "interaction"],
  sbMode: "auto",
  sbExtras: true,
  saveEnabled: false,
};
const CATEGORIES = {
  sponsor: "Sponsor",
  selfpromo: "Self-promotion",
  interaction: "Subscribe/like reminders",
  intro: "Intro animation",
  outro: "Endcards/credits",
  preview: "Preview/recap",
  filler: "Filler tangent",
  music_offtopic: "Non-music in music videos",
};

const $ = (id) => document.getElementById(id);
const save = (obj) => browser.storage.local.set(obj);

function checkHelper() {
  const el = $("helper");
  el.hidden = $("source").value !== "helper";
  if (el.hidden) return;
  el.textContent = "Checking helper…";
  browser.runtime.sendMessage({ type: "helper", path: "/ping" }).then((r) => {
    el.textContent = r?.ok ? "Helper: running ✓" : "Helper: not running (start helper/server.py)";
  });
}

browser.storage.local.get(DEFAULTS).then((s) => {
  for (const id of ["enabled", "hideAds", "hideShorts", "returnDislike", "saveEnabled", "sponsorBlock", "sbExtras"]) {
    $(id).checked = s[id];
    $(id).addEventListener("change", () => {
      save({ [id]: $(id).checked });
      if (id === "sponsorBlock") $("sbOpts").hidden = !$(id).checked;
    });
  }
  $("sbMode").value = s.sbMode;
  $("sbMode").addEventListener("change", () => save({ sbMode: $("sbMode").value }));
  $("source").value = s.source;
  $("source").addEventListener("change", () => {
    save({ source: $("source").value });
    checkHelper();
  });
  checkHelper();

  $("sbOpts").hidden = !s.sponsorBlock;
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: s.sbCategories.includes(key) });
    box.addEventListener("change", () => {
      const chosen = [...$("sbCats").querySelectorAll("input")].filter((b) => b.checked).map((b) => b.dataset.key);
      save({ sbCategories: chosen });
    });
    box.dataset.key = key;
    const row = document.createElement("label");
    row.append(box, label);
    $("sbCats").append(row);
  }
});
