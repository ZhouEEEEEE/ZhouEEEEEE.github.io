(() => {
  "use strict";
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  const links = [...document.querySelectorAll('.main-nav a[href^="#"]')];
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  let scheduled = false;

  function updateNavigation() {
    const threshold = (document.querySelector(".site-header")?.offsetHeight || 76) + 80;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= threshold) current = section;
    }
    for (const link of links) {
      if (link.getAttribute("href") === `#${current?.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    scheduled = false;
  }

  window.addEventListener("scroll", () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(updateNavigation);
    }
  }, { passive: true });
  window.addEventListener("resize", updateNavigation);
  updateNavigation();
})();
