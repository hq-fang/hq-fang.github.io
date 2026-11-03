/*
 * Site behaviour -- plain JavaScript, no dependencies, loaded with `defer`.
 *
 *   theme toggle . priority ("greedy") navigation . current-section highlight .
 *   collapsible news . publication view switch . lazy publication videos .
 *   visitor-map theme sync . e-mail de-obfuscation . MathJax / Mermaid / Plotly on demand
 *
 * The initial colour theme is applied by an inline script in _includes/head.html (before
 * first paint); everything here is progressive enhancement, so the page already looks right
 * while this file is still downloading on a slow connection.
 */
(() => {
  "use strict";

  const root = document.documentElement;
  const scriptUrl = document.currentScript ? document.currentScript.src : window.location.href;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  /* ---------------------------------------------------------------- theme */

  // The saved theme is already applied by the inline script in <head>; default is light.
  const currentTheme = () => (root.getAttribute("data-theme") === "dark" ? "dark" : "light");

  const applyTheme = (theme) => {
    if (theme === "dark") {
      root.setAttribute("data-theme", "dark");
    } else {
      root.removeAttribute("data-theme");
    }
    // sun in light mode, moon in dark mode (same as the original jQuery code)
    const icon = $("#theme-icon");
    if (icon) {
      icon.classList.toggle("fa-sun", theme !== "dark");
      icon.classList.toggle("fa-moon", theme === "dark");
    }
  };

  const initTheme = () => {
    applyTheme(currentTheme());
    const toggle = $("#theme-toggle");
    if (!toggle) {
      return;
    }
    toggle.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("theme", next);
      } catch (error) {
        /* private mode: the choice just won't persist */
      }
      applyTheme(next);
    });
  };

  /* ------------------------------------------------------ greedy navigation */

  // Moves masthead links that don't fit into a dropdown, right to left.
  const initGreedyNav = () => {
    const nav = $("#site-nav");
    if (!nav) {
      return;
    }
    const button = $(":scope > button", nav);
    const visible = $(".visible-links", nav);
    const hidden = $(".hidden-links", nav);
    const tail = $(":scope > .persist.tail", visible);
    const breaks = [];

    const movable = () => $$(":scope > li:not(.persist)", visible);
    // Content-box width, measured exactly like jQuery's .width() so links collapse into the
    // menu at the same widths as before.
    const width = (element) => {
      const style = window.getComputedStyle(element);
      let value = parseFloat(style.width) || 0;
      if (style.boxSizing === "border-box") {
        value -= parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      }
      return value;
    };
    const availableSpace = () =>
      button.classList.contains("hidden") ? width(nav) : width(nav) - width(button) - 30;

    const setOpen = (open) => {
      hidden.classList.toggle("hidden", !open);
      button.classList.toggle("close", open);
      button.setAttribute("aria-expanded", String(open));
    };

    const update = () => {
      let space = availableSpace();
      if (width(visible) > space) {
        while (width(visible) > space && movable().length > 0) {
          breaks.push(width(visible));
          const items = movable();
          hidden.insertBefore(items[items.length - 1], hidden.firstChild);
          button.classList.remove("hidden");
          space = availableSpace();
        }
      } else {
        while (breaks.length > 0 && space > breaks[breaks.length - 1]) {
          const item = hidden.firstElementChild;
          if (tail) {
            visible.insertBefore(item, tail);
          } else {
            visible.appendChild(item);
          }
          breaks.pop();
        }
        if (breaks.length === 0) {
          button.classList.add("hidden");
          setOpen(false);
        }
      }
      button.setAttribute("data-count", String(breaks.length));

      // As the old jQuery version did: offset the page (and the fixed sidebar) by the
      // masthead's actual height.
      const masthead = $(".masthead");
      const sidebar = $(".sidebar");
      if (masthead) {
        const height = `${parseFloat(window.getComputedStyle(masthead).height)}px`;
        document.body.style.paddingTop = height;
        if (sidebar) {
          sidebar.style.paddingTop = height;
        }
      }
    };

    let frame = 0;
    const scheduleUpdate = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(hidden.classList.contains("hidden"));
    });
    hidden.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        setOpen(false);
      }
    });
    document.addEventListener("click", (event) => {
      if (!nav.contains(event.target)) {
        setOpen(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    });
    window.addEventListener("resize", scheduleUpdate);

    // The original script made its first measurement with the button visible; do the same
    // (within this synchronous call, so nothing flashes) so links collapse at the same widths.
    button.classList.remove("hidden");
    update();
    root.classList.add("nav-ready");
  };

  /* --------------------------------------------- current-section highlight */

  const initSectionHighlight = () => {
    const masthead = $(".masthead");
    const links = $$("#site-nav a[data-nav-section]");
    if (!masthead || links.length === 0) {
      return;
    }

    const sections = [];
    links.forEach((link) => {
      const element = document.getElementById(link.dataset.navSection);
      if (element && !sections.some((section) => section.element === element)) {
        sections.push({ id: link.dataset.navSection, element });
      }
    });
    if (sections.length === 0) {
      return;
    }

    let active = null;
    const setActive = (id) => {
      if (!id || id === active) {
        return;
      }
      active = id;
      links.forEach((link) => {
        const isActive = link.dataset.navSection === id;
        link.classList.toggle("is-current-section", isActive);
        if (isActive) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    };

    const compute = () => {
      const marker = window.scrollY + masthead.offsetHeight + Math.min(window.innerHeight * 0.18, 140);
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        return sections[sections.length - 1].id;
      }
      let current = sections[0].id;
      sections.forEach((section) => {
        if (section.element.offsetTop <= marker) {
          current = section.id;
        }
      });
      return current;
    };

    let frame = 0;
    const scheduleUpdate = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setActive(compute());
        });
      }
    };

    links.forEach((link) => link.addEventListener("click", () => setActive(link.dataset.navSection)));
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("hashchange", scheduleUpdate);
    window.addEventListener("load", scheduleUpdate);
    scheduleUpdate();
    window.setTimeout(scheduleUpdate, 160);
  };

  /* ------------------------------------------------------- collapsible news */

  // The list is collapsed by CSS from the first paint (see .is-collapsed in _home.scss);
  // this only wires up the toggle button.
  const initCollapsibleLists = () => {
    $$("[data-collapsible-list]").forEach((list) => {
      const toggle = $$("[data-list-toggle]").find((candidate) => candidate.getAttribute("aria-controls") === list.id);
      if (!toggle) {
        return;
      }
      const label = $(".home-news__toggle-label", toggle);
      const expandLabel = list.dataset.expandLabel || "Show more";
      const collapseLabel = list.dataset.collapseLabel || "Show less";
      const limit = Number.parseInt(list.dataset.initialLimit || "5", 10);

      if (list.children.length <= limit) {
        list.classList.remove("is-collapsed");
        toggle.hidden = true;
        return;
      }

      const render = () => {
        const expanded = !list.classList.contains("is-collapsed");
        toggle.setAttribute("aria-expanded", String(expanded));
        if (label) {
          label.textContent = expanded ? collapseLabel : expandLabel;
        } else {
          toggle.setAttribute("aria-label", expanded ? collapseLabel : expandLabel);
        }
      };

      toggle.addEventListener("click", () => {
        const collapsing = !list.classList.contains("is-collapsed");
        list.classList.toggle("is-collapsed", collapsing);
        render();
        // After collapsing a long list, keep the button in view instead of leaving the
        // reader stranded further down the page.
        if (collapsing && toggle.getBoundingClientRect().top < 0) {
          toggle.scrollIntoView({ block: "center" });
        }
      });
      render();
    });
  };

  /* ------------------------------------------------- publication view switch */

  const initPublicationSwitch = (onChange) => {
    const buttons = $$("[data-publication-switch]");
    const views = $$("[data-publication-view]");
    if (buttons.length === 0 || views.length === 0) {
      return;
    }
    const show = (name) => {
      buttons.forEach((button) => {
        const isActive = button.dataset.publicationSwitch === name;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", String(isActive));
      });
      views.forEach((view) => {
        view.hidden = view.dataset.publicationView !== name;
      });
      onChange();
    };
    buttons.forEach((button) => button.addEventListener("click", () => show(button.dataset.publicationSwitch)));
  };

  /* ---------------------------------------------------- publication videos */

  // Videos ship without a `src`: the poster <img> shows immediately, and the MP4 is only
  // fetched when the card scrolls into view. Videos in the hidden "All publications" tab
  // never download unless that tab is opened. With Data Saver, a 2G connection or
  // "reduce motion", the poster simply stays.
  const initPublicationVideos = () => {
    const videos = $$("video.publication-card__video[data-src]");
    if (videos.length === 0) {
      return () => {};
    }

    const connection = navigator.connection || {};
    const constrained = connection.saveData === true || /(^|-)2g$/.test(connection.effectiveType || "");
    const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    const inView = new Set();

    const rateOf = (video) => {
      const rate = Number.parseFloat(video.dataset.playbackRate || "1");
      return Number.isFinite(rate) && rate > 0 ? rate : 1;
    };

    const play = (video) => {
      if (constrained || reducedMotion.matches || video.closest("[hidden]")) {
        return;
      }
      if (!video.getAttribute("src")) {
        video.src = video.dataset.src;
      }
      video.muted = true;
      video.defaultPlaybackRate = rateOf(video);
      video.playbackRate = rateOf(video);
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => {}); // e.g. iOS Low Power Mode: keep showing the poster
      }
    };

    videos.forEach((video) => {
      // Loading a source resets playbackRate, so re-apply it.
      video.addEventListener("loadedmetadata", () => {
        video.playbackRate = rateOf(video);
      });
      video.addEventListener("playing", () => {
        video.parentElement.classList.add("is-playing");
      });
    });

    const refresh = () => {
      videos.forEach((video) => {
        if (inView.has(video) && document.visibilityState === "visible") {
          play(video);
        } else if (!video.paused) {
          video.pause();
        }
      });
    };

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              inView.add(entry.target);
            } else {
              inView.delete(entry.target);
            }
          });
          refresh();
        },
        { rootMargin: "200px 0px" },
      );
      videos.forEach((video) => observer.observe(video));
    } else {
      videos.forEach((video) => inView.add(video));
      refresh();
    }

    document.addEventListener("visibilitychange", refresh);
    if (reducedMotion.addEventListener) {
      reducedMotion.addEventListener("change", refresh);
    }
    return refresh;
  };

  /* --------------------------------------------------------- visitor map */

  const initVisitorMap = () => {
    const image = $("[data-visitor-map-image]");
    const link = $("[data-visitor-map-link]");
    if (!image || !link) {
      return;
    }
    const sync = () => {
      const theme = currentTheme();
      const imageUrl = new URL(image.getAttribute("src"), window.location.href);
      const linkUrl = new URL(link.getAttribute("href"), window.location.href);
      imageUrl.searchParams.set("track", "0");
      imageUrl.searchParams.set("theme", theme);
      linkUrl.searchParams.set("theme", theme);
      if (image.src !== imageUrl.href) {
        image.src = imageUrl.href;
      }
      if (link.href !== linkUrl.href) {
        link.href = linkUrl.href;
      }
    };
    sync();
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  };

  /* ------------------------------------------------- e-mail de-obfuscation */

  // Addresses are written as "name [at] host [dot] edu" to deter scrapers; turn them back
  // into a working mailto: link at the moment someone actually clicks it.
  const initEmailLinks = () => {
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest('a[href^="mailto:"]');
      if (!link) {
        return;
      }
      const href = link.getAttribute("href");
      const clean = href
        .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
        .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
        .replace(/\s+/g, "");
      if (clean !== href) {
        link.setAttribute("href", clean);
      }
    });
  };

  /* -------------------------------------- MathJax / Mermaid / Plotly on demand */

  const loadScript = (src, attributes = {}) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      Object.keys(attributes).forEach((key) => script.setAttribute(key, attributes[key]));
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

  const initOnDemandLibraries = () => {
    const content = $(".page__content") || document.body;

    // kramdown turns $$...$$ into \(...\) / \[...\]
    if (/\\\(|\\\[|\$\$/.test(content.textContent)) {
      loadScript("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js", { id: "MathJax-script" }).catch(() => {});
    }

    if ($("code.language-mermaid")) {
      import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")
        .then(({ default: mermaid }) => {
          mermaid.initialize({ startOnLoad: false, theme: currentTheme() === "dark" ? "dark" : "default" });
          return mermaid.run({ querySelector: "code.language-mermaid" });
        })
        .catch(() => {});
    }

    const plotlyBlocks = $$("pre > code.language-plotly");
    if (plotlyBlocks.length > 0) {
      Promise.all([
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/plotly.js/3.0.1/plotly.min.js"),
        import(new URL("theme.js", scriptUrl).href),
      ])
        .then(([, themes]) => {
          plotlyBlocks.forEach((block) => {
            const data = JSON.parse(block.textContent);
            block.parentElement.classList.add("hidden");
            const chart = document.createElement("div");
            block.parentElement.after(chart);
            const template = currentTheme() === "dark" ? themes.plotlyDarkLayout : themes.plotlyLightLayout;
            data.layout = data.layout || {};
            data.layout.template = data.layout.template ? { ...template, ...data.layout.template } : template;
            window.Plotly.react(chart, data.data, data.layout);
          });
        })
        .catch(() => {});
    }
  };

  /* ----------------------------------------------------------------- init */

  const run = (name, init) => {
    try {
      return init();
    } catch (error) {
      // One broken widget should never take the rest of the page down with it.
      console.error(`[site.js] ${name} failed`, error);
      return undefined;
    }
  };

  run("theme", initTheme);
  run("navigation", initGreedyNav);
  run("section highlight", initSectionHighlight);
  run("collapsible lists", initCollapsibleLists);
  const refreshVideos = run("videos", initPublicationVideos) || (() => {});
  run("publication switch", () => initPublicationSwitch(() => window.requestAnimationFrame(refreshVideos)));
  run("visitor map", initVisitorMap);
  run("email links", initEmailLinks);
  run("on-demand libraries", initOnDemandLibraries);
})();
