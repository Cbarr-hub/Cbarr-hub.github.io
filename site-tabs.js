(function () {
  const pages = [
    { label: "Home", path: "index.html" },
    { label: "Retro", path: "index2.html" },
    { label: "Gamble", path: "gamble.html" },
    { label: "Algorithms", path: "Algs/advanced_algorithms.html", match: ["Algs/", "random_sort.html"] },
    { label: "Design", path: "design_phil.html" },
    { label: "Wheel", path: "wheel.html" },
    { label: "Tablets", path: "tablets.html" },
    { label: "Forum", path: "forum.html" },
    { label: "Faith", path: "faith.html" },
    { label: "KPI", path: "kpi.html" },
    { label: "Support", path: "support.html" },
    { label: "Fish Tank", path: "fishtank.html" }
  ];

  function getBasePath() {
    const script = document.currentScript;
    if (!script) return "";
    const src = script.getAttribute("src") || "";
    return src.replace(/site-tabs\.js(?:\?.*)?$/, "");
  }

  function getCurrentPath() {
    const file = window.location.pathname.split("/").filter(Boolean).join("/");
    return file || "index.html";
  }

  function isCurrentPage(page, currentPath) {
    const normalized = currentPath.replace(/\\/g, "/");
    if (normalized.endsWith(page.path)) return true;
    return Boolean(page.match && page.match.some((prefix) => normalized.includes(prefix)));
  }

  function installTabs() {
    if (document.querySelector(".global-tabbar")) return;

    const currentPadding = window.getComputedStyle(document.body).paddingTop;
    document.body.style.setProperty("--global-tabs-body-padding", currentPadding);
    document.body.classList.add("has-global-tabs");

    const basePath = getBasePath();
    const currentPath = getCurrentPath();
    const bar = document.createElement("nav");
    bar.className = "global-tabbar";
    bar.setAttribute("aria-label", "Site tabs");

    const links = document.createElement("div");
    links.className = "global-tabbar__links";

    pages.forEach((page) => {
      const link = document.createElement("a");
      link.className = "global-tabbar__tab";
      link.href = `${basePath}${page.path}`;
      link.textContent = page.label;
      if (isCurrentPage(page, currentPath)) {
        link.setAttribute("aria-current", "page");
      }
      links.appendChild(link);
    });

    bar.appendChild(links);
    document.body.prepend(bar);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installTabs);
  } else {
    installTabs();
  }
})();
