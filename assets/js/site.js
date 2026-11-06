/*
 * Site behaviour -- plain JavaScript, no dependencies, loaded with `defer`.
 *
 *   theme toggle . current-section highlight .
 *   collapsible news . publication view switch . lazy publication videos .
 *   visitor-map theme sync . e-mail de-obfuscation . MathJax / Mermaid / Plotly on demand
 *
 * The initial colour theme is applied by an inline script in _includes/head.html, and the
 * priority ("greedy") navigation by one in _includes/masthead.html, both before first
 * paint; everything here is progressive enhancement, so the page already looks right
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

    /* Everything is measured with getBoundingClientRect (on-screen pixels): the page has
       `zoom: 0.9` on <html>, and offsetTop / scrollHeight are unzoomed CSS pixels, which
       don't match the scroll position (the highlight lagged and never reached the end). */
    /* A link clicked near the end of the page (e.g. Work on a tall screen, where its heading
       can't scroll to the top) keeps its highlight at the bottom until the user scrolls. */
    let clicked = null;
    const compute = () => {
      const marker = masthead.getBoundingClientRect().bottom + Math.min(window.innerHeight * 0.18, 140);
      if (document.body.getBoundingClientRect().bottom <= window.innerHeight + 2) {
        const target = clicked && document.getElementById(clicked);
        const top = target ? target.getBoundingClientRect().top : -1;
        return top >= 0 && top < window.innerHeight ? clicked : sections[sections.length - 1].id;
      }
      let current = sections[0].id;
      sections.forEach((section) => {
        if (section.element.getBoundingClientRect().top <= marker) {
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

    links.forEach((link) => link.addEventListener("click", () => {
      clicked = link.dataset.navSection;
      setActive(clicked);
    }));
    ["wheel", "touchstart", "keydown"].forEach((type) => {
      window.addEventListener(type, () => { clicked = null; }, { passive: true });
    });
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("hashchange", scheduleUpdate);
    window.addEventListener("load", scheduleUpdate);
    scheduleUpdate();
    window.setTimeout(scheduleUpdate, 160);
  };

  /* ------------------------------------------------------- collapsible news */

  // CSS collapses the list from the first paint (.is-collapsed in _home.scss) and the inline
  // script in _includes/head.html handles the button. Here: if CSS hides nothing (a short list),
  // drop the collapsed state and the button.
  const initCollapsibleLists = () => {
    $$("[data-collapsible-list].is-collapsed").forEach((list) => {
      const hidesSomething = Array.from(list.children).some((item) => window.getComputedStyle(item).display === "none");
      if (hidesSomething) {
        return;
      }
      list.classList.remove("is-collapsed");
      $$("[data-list-toggle]")
        .filter((toggle) => toggle.getAttribute("aria-controls") === list.id)
        .forEach((toggle) => {
          (toggle.closest(".home-news__controls") || toggle).style.display = "none";
        });
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
    const rateOf = (video) => {
      const rate = Number.parseFloat(video.dataset.playbackRate || "1");
      return Number.isFinite(rate) && rate > 0 ? rate : 1;
    };

    // Teasers embedded without a poster autoplay natively; just keep their speed.
    $$("video.publication-card__video[data-playback-rate]:not([data-src])").forEach((video) => {
      const apply = () => {
        video.defaultPlaybackRate = rateOf(video);
        video.playbackRate = rateOf(video);
      };
      ["loadedmetadata", "play"].forEach((name) => video.addEventListener(name, apply));
      apply();
    });

    const videos = $$("video.publication-card__video[data-src]");
    if (videos.length === 0) {
      return () => {};
    }

    const connection = navigator.connection || {};
    const constrained = connection.saveData === true || /(^|-)2g$/.test(connection.effectiveType || "");
    const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
    const inView = new Set();

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
    // Autoplay can be refused until the first user gesture (e.g. iOS Low Power Mode): retry then.
    const retryOnce = () => {
      refresh();
      window.removeEventListener("touchstart", retryOnce);
      window.removeEventListener("pointerdown", retryOnce);
    };
    window.addEventListener("touchstart", retryOnce, { passive: true });
    window.addEventListener("pointerdown", retryOnce, { passive: true });
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
    const report = (what) => (error) => console.error(`[site.js] ${what} failed to load`, error);

    // kramdown turns $$...$$ into \(...\) / \[...\] (titles and headers count too)
    if (/\\\(|\\\[|\$\$/.test(document.body.textContent)) {
      loadScript("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js", { id: "MathJax-script" }).catch(report("MathJax"));
    }

    if ($("code.language-mermaid")) {
      import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")
        .then(({ default: mermaid }) => {
          mermaid.initialize({ startOnLoad: false, theme: currentTheme() === "dark" ? "dark" : "default" });
          return mermaid.run({ querySelector: "code.language-mermaid" });
        })
        .catch(report("Mermaid"));
    }

    const plotlyBlocks = $$("pre > code.language-plotly");
    if (plotlyBlocks.length > 0) {
      Promise.all([
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/plotly.js/3.0.1/plotly.min.js"),
        import(new URL("theme.js", scriptUrl).href),
      ])
        .then(([, themes]) => {
          plotlyBlocks.forEach((block) => {
            try {
              const data = JSON.parse(block.textContent);
              block.parentElement.classList.add("hidden");
              const chart = document.createElement("div");
              block.parentElement.after(chart);
              const template = currentTheme() === "dark" ? themes.plotlyDarkLayout : themes.plotlyLightLayout;
              data.layout = data.layout || {};
              data.layout.template = data.layout.template ? { ...template, ...data.layout.template } : template;
              window.Plotly.react(chart, data.data, data.layout);
            } catch (error) {
              console.error("[site.js] could not render a plotly block", error, block);
            }
          });
        })
        .catch(report("Plotly"));
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
  run("section highlight", initSectionHighlight);
  run("collapsible lists", initCollapsibleLists);
  const refreshVideos = run("videos", initPublicationVideos) || (() => {});
  run("publication switch", () => initPublicationSwitch(() => window.requestAnimationFrame(refreshVideos)));
  run("visitor map", initVisitorMap);
  run("email links", initEmailLinks);
  run("on-demand libraries", initOnDemandLibraries);
})();
