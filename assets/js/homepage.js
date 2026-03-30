document.addEventListener("DOMContentLoaded", () => {
  const siteNav = document.getElementById("site-nav");
  const masthead = document.querySelector(".masthead");
  const root = document.documentElement;

  const initializeVisitorCountWidgets = () => {
    const visitorWidgets = Array.from(document.querySelectorAll("[data-visitor-count-widget]"));

    if (visitorWidgets.length === 0) {
      return;
    }

    const syncVisitorWidgetTheme = () => {
      const styles = window.getComputedStyle(root);
      const mode = root.dataset.theme === "dark" ? "dark" : "light";
      const accent = styles.getPropertyValue("--global-accent-color").trim() || "#6E59CF";

      visitorWidgets.forEach((widget) => {
        widget.setAttribute("mode", mode);
        widget.setAttribute("accent", accent);
      });
    };

    syncVisitorWidgetTheme();

    const observer = new MutationObserver(syncVisitorWidgetTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  };

  const initializeSectionNavigation = () => {
    if (!siteNav || !masthead) {
      return;
    }

    const sectionLinks = Array.from(siteNav.querySelectorAll("a[data-nav-section]"));

    if (sectionLinks.length === 0) {
      return;
    }

    const sectionEntries = Array.from(
      new Map(
        sectionLinks
          .map((link) => {
            const sectionId = link.dataset.navSection;

            if (!sectionId) {
              return null;
            }

            const element = document.getElementById(sectionId);

            if (!element) {
              return null;
            }

            return [sectionId, { sectionId, element }];
          })
          .filter(Boolean),
      ).values(),
    );

    if (sectionEntries.length === 0) {
      return;
    }

    let activeSectionId = null;
    let rafId = null;

    const setActiveSection = (sectionId) => {
      if (!sectionId || activeSectionId === sectionId) {
        return;
      }

      activeSectionId = sectionId;

      sectionLinks.forEach((link) => {
        const isActive = link.dataset.navSection === sectionId;
        link.classList.toggle("is-current-section", isActive);

        if (isActive) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    };

    const getActivationOffset = () => masthead.offsetHeight + Math.min(window.innerHeight * 0.18, 140);

    const getActiveSectionId = () => {
      const scrollMarker = window.scrollY + getActivationOffset();
      let currentSectionId = sectionEntries[0].sectionId;

      sectionEntries.forEach(({ sectionId, element }) => {
        if (element.offsetTop <= scrollMarker) {
          currentSectionId = sectionId;
        }
      });

      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        return sectionEntries[sectionEntries.length - 1].sectionId;
      }

      return currentSectionId;
    };

    const updateActiveSection = () => {
      rafId = null;
      setActiveSection(getActiveSectionId());
    };

    const requestUpdate = () => {
      if (rafId !== null) {
        return;
      }

      rafId = window.requestAnimationFrame(updateActiveSection);
    };

    sectionLinks.forEach((link) => {
      link.addEventListener("click", () => {
        setActiveSection(link.dataset.navSection);
      });
    });

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("orientationchange", requestUpdate);
    window.addEventListener("hashchange", requestUpdate);

    requestUpdate();
    window.setTimeout(requestUpdate, 160);
  };

  initializeVisitorCountWidgets();
  initializeSectionNavigation();

  const publicationButtons = Array.from(document.querySelectorAll("[data-publication-switch]"));
  const publicationViews = Array.from(document.querySelectorAll("[data-publication-view]"));
  let refreshPublicationVideos = () => {};

  const setPublicationView = (viewName) => {
    publicationButtons.forEach((button) => {
      const isActive = button.dataset.publicationSwitch === viewName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    publicationViews.forEach((view) => {
      view.hidden = view.dataset.publicationView !== viewName;
    });

    window.requestAnimationFrame(() => {
      refreshPublicationVideos();
    });
  };

  publicationButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setPublicationView(button.dataset.publicationSwitch);
    });
  });

  if (publicationButtons.length && publicationViews.length) {
    setPublicationView("selected");
  }

  const initializeCollapsibleList = (list) => {
    if (!(list instanceof HTMLElement) || !list.id) {
      return;
    }

    const toggle = Array.from(document.querySelectorAll("[data-list-toggle]")).find(
      (candidate) => candidate.getAttribute("aria-controls") === list.id,
    );

    if (!toggle) {
      return;
    }

    const items = Array.from(list.children);
    const limit = Number.parseInt(list.dataset.initialLimit || "5", 10);
    const collapsibleItems = items.slice(limit);
    const controls = toggle.closest(".home-news__controls");
    const expandLabel = list.dataset.expandLabel || "Expand list";
    const collapseLabel = list.dataset.collapseLabel || "Collapse list";
    let expanded = false;
    let extraList = null;

    if (collapsibleItems.length > 0 && controls) {
      extraList = document.createElement("ul");
      extraList.className = `${list.className} home-news__list--extra`;
      extraList.setAttribute("aria-hidden", "true");

      collapsibleItems.forEach((item) => {
        extraList.appendChild(item);
      });

      controls.parentNode.insertBefore(extraList, controls);
    }

    const updateState = () => {
      const canToggle = Boolean(extraList);
      toggle.hidden = !canToggle;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? collapseLabel : expandLabel);
      list.classList.toggle("is-collapsed", canToggle && !expanded);

      if (!extraList) {
        return;
      }

      if (expanded) {
        extraList.classList.add("is-expanded");
        extraList.setAttribute("aria-hidden", "false");
        extraList.style.maxHeight = `${extraList.scrollHeight}px`;
      } else {
        extraList.classList.remove("is-expanded");
        extraList.setAttribute("aria-hidden", "true");
        extraList.style.maxHeight = "0px";
      }
    };

    toggle.addEventListener("click", () => {
      expanded = !expanded;
      updateState();
    });

    updateState();

    if (extraList) {
      window.addEventListener("resize", () => {
        if (expanded) {
          extraList.style.maxHeight = `${extraList.scrollHeight}px`;
        }
      });
    }
  };

  Array.from(document.querySelectorAll("[data-collapsible-list]")).forEach((list) => {
    initializeCollapsibleList(list);
  });

  const autoplayVideo = (video) => {
    if (!(video instanceof HTMLVideoElement)) {
      return;
    }

    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
    video.setAttribute("loop", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("disablepictureinpicture", "");
    video.setAttribute("disableremoteplayback", "");
    video.setAttribute("preload", "metadata");

    if (video.readyState === 0) {
      video.load();
    }

    const playPromise = video.play();

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  };

  const publicationVideos = Array.from(document.querySelectorAll("video[data-playback-rate]"));

  publicationVideos.forEach((video) => {
    const playbackRate = Number.parseFloat(video.dataset.playbackRate || "1");

    if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
      return;
    }

    const applyPlaybackRate = () => {
      if (video.playbackRate !== playbackRate) {
        video.playbackRate = playbackRate;
      }
    };

    video.addEventListener("loadedmetadata", applyPlaybackRate);
    video.addEventListener("play", applyPlaybackRate);
    video.addEventListener("ratechange", applyPlaybackRate);
    video.addEventListener("loadeddata", () => autoplayVideo(video));
    video.addEventListener("canplay", () => autoplayVideo(video));
    video.preload = "metadata";
    applyPlaybackRate();
  });

  if (publicationVideos.length > 0) {
    const isVideoVisible = (video) => {
      if (!(video instanceof HTMLVideoElement) || video.closest("[hidden]")) {
        return false;
      }

      const rect = video.getBoundingClientRect();
      return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };

    const replayVisibleVideos = () => {
      publicationVideos.forEach((video) => {
        if (isVideoVisible(video)) {
          autoplayVideo(video);
        } else {
          video.pause();
        }
      });
    };

    refreshPublicationVideos = replayVisibleVideos;

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !entry.target.closest("[hidden]")) {
              autoplayVideo(entry.target);
            }
          });
        },
        {
          threshold: 0.2,
          rootMargin: "80px 0px",
        },
      );

      publicationVideos.forEach((video) => observer.observe(video));
    } else {
      window.addEventListener("scroll", replayVisibleVideos, { passive: true });
    }

    const retryAutoplayOnce = () => {
      replayVisibleVideos();
      window.removeEventListener("touchstart", retryAutoplayOnce);
      window.removeEventListener("pointerdown", retryAutoplayOnce);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        replayVisibleVideos();
      }
    });

    window.addEventListener("pageshow", replayVisibleVideos);
    window.addEventListener("resize", replayVisibleVideos);
    window.addEventListener("orientationchange", replayVisibleVideos);
    window.addEventListener("touchstart", retryAutoplayOnce, { passive: true });
    window.addEventListener("pointerdown", retryAutoplayOnce, { passive: true });
    window.setTimeout(replayVisibleVideos, 160);
  }
});
