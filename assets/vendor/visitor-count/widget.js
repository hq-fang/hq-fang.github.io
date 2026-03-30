(function () {
  const scriptUrl = document.currentScript?.src
    ? new URL(document.currentScript.src)
    : new URL(window.location.href);
  const scriptBaseUrl = new URL("./", scriptUrl);
  const DEFAULT_API_BASE = `${scriptUrl.origin}/`;
  const DEFAULT_EMBED_TOKEN = scriptUrl.searchParams.get("token") || "";
  const GIS_DATA_URL = new URL("continents.gis.json", scriptBaseUrl).toString();
  const SHARED_STATE = (window.__visitorCountState =
    window.__visitorCountState || {
      trackedSites: new Set(),
      requestCache: new Map(),
    });

  class VisitorCountWidget extends HTMLElement {
    static get observedAttributes() {
      return [
        "site-id",
        "widget",
        "api",
        "token",
        "days",
        "range",
        "mode",
        "accent",
        "label",
        "demo",
        "track",
        "metric",
      ];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.latestResolved = null;
      this.horizontalMetric = null;
      this.renderLoading();
    }

    connectedCallback() {
      this.load();
    }

    attributeChangedCallback() {
      if (this.isConnected) {
        this.load();
      }
    }

    get config() {
      const requestedWidget = (this.getAttribute("widget") || "number").toLowerCase();
      const defaultDays = requestedWidget === "heatmap" ? 84 : 30;
      const token = this.getAttribute("token") || this.dataset.token || DEFAULT_EMBED_TOKEN;
      const tokenPayload = readEmbedTokenPayload(token);
      const tokenSiteId = normalizeSiteId(tokenPayload?.siteId);
      const range = readRangeConfig(
        requestedWidget,
        this.getAttribute("range"),
        this.getAttribute("days"),
        defaultDays,
      );

      return {
        apiBase: ensureTrailingSlash(this.getAttribute("api") || DEFAULT_API_BASE),
        siteId: this.getAttribute("site-id") || this.dataset.siteId || tokenSiteId || "demo-site",
        token,
        tokenPayload,
        widget: requestedWidget,
        days: range.days,
        rangeMode: range.mode,
        mode: (this.getAttribute("mode") || "light").toLowerCase(),
        accent: this.getAttribute("accent") || "#12776b",
        label: this.getAttribute("label") || "Visitors",
        demo: this.hasAttribute("demo"),
        track: this.getAttribute("track") !== "false",
        metric: normalizeRegionMetric(this.getAttribute("metric")),
      };
    }

    async load() {
      const token = Symbol("render");
      this.renderToken = token;
      const baseConfig = this.config;
      const access = resolveEmbedAccess(baseConfig);

      if (!access.ok) {
        if (baseConfig.demo) {
          const fallback = await resolveDemoData(baseConfig);
          if (this.renderToken !== token) {
            return;
          }

          this.renderResolved(baseConfig, fallback);
          return;
        }

        this.renderError(access.message, baseConfig);
        return;
      }

      const config = {
        ...baseConfig,
        siteId: access.siteId,
        token: access.token,
        tokenPayload: access.payload,
      };
      this.horizontalMetric = config.widget === "horizontal" ? config.metric : null;

      this.renderLoading(config);

      if (config.track) {
        trackVisit(config);
      }

      try {
        const data = await this.fetchWidgetData(config);

        if (this.renderToken !== token) {
          return;
        }

        this.renderResolved(config, data);
      } catch (error) {
        const fallback = config.demo ? await resolveDemoData(config) : null;

        if (this.renderToken !== token) {
          return;
        }

        if (fallback) {
          this.renderResolved(config, fallback);
          return;
        }

        this.renderError(error instanceof Error ? error.message : "Failed to load widget.", config);
      }
    }

    renderResolved(config, data) {
      const resolvedConfig =
        config.widget === "horizontal"
          ? {
              ...config,
              metric: this.horizontalMetric || config.metric,
            }
          : config;
      this.latestResolved = { config: resolvedConfig, data };

      if (resolvedConfig.widget === "horizontal") {
        this.renderHorizontal(resolvedConfig, data);
        return;
      }

      if (resolvedConfig.widget === "regions") {
        this.renderRegions(resolvedConfig, data);
        return;
      }

      if (resolvedConfig.widget === "heatmap") {
        this.renderHeatmap(resolvedConfig, data);
        return;
      }

      this.renderNumber(resolvedConfig, data);
    }

    async fetchWidgetData(config) {
      const widgetEndpoint =
        config.widget === "number"
          ? "summary"
          : config.widget === "horizontal"
            ? "regions"
            : config.widget;
      const url = new URL(
        `api/sites/${encodeURIComponent(config.siteId)}/${widgetEndpoint}`,
        config.apiBase,
      );
      url.searchParams.set("token", config.token);
      if (config.rangeMode === "all") {
        url.searchParams.set("range", "all");
      } else {
        url.searchParams.set("days", String(config.days));
      }

      const response = await cachedJson(url.toString());
      const resolved =
        config.demo && isZeroPayload(config.widget, response)
          ? buildDemoData(config.widget, config)
          : response;

      if (config.widget === "regions" || config.widget === "horizontal") {
        return withRegionShapes(resolved);
      }

      return resolved;
    }

    renderLoading(config = this.config) {
      const { mode, accent } = config;
      this.latestResolved = null;
      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(mode, accent)}</style>
        <section class="widget loading">
          <div class="shine"></div>
          <div class="skeleton title"></div>
          <div class="skeleton metric"></div>
          <div class="skeleton line"></div>
        </section>
      `;
    }

    renderError(message, config = this.config) {
      const { mode, accent } = config;
      this.latestResolved = null;
      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(mode, accent)}</style>
        <section class="widget error-state">
          <div class="eyebrow">Visitor count</div>
          <div class="headline">Unavailable</div>
          <div class="muted">${escapeHtml(message)}</div>
        </section>
      `;
    }

    renderNumber(config, data) {
      const total = data.window?.uniqueVisitors || 0;
      const pageViews = data.window?.pageViews || 0;
      const trend = data.window?.trendPct;
      const rangeCopy = formatRangeCopy(config, data);
      const isAllTime = resolveRangeMode(config, data) === "all";
      const trendClass = typeof trend === "number" ? (trend >= 0 ? "up" : "down") : "flat";
      const trendText =
        isAllTime
          ? "Since first visit"
          : typeof trend === "number"
          ? `${trend >= 0 ? "+" : ""}${trend}% vs previous`
          : "Fresh traffic baseline";

      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(config.mode, config.accent)}</style>
        <section class="widget number-card">
          <div class="orb"></div>
          <div class="eyebrow">${escapeHtml(config.label)}</div>
          <div class="headline">Live audience pulse</div>
          <div class="metric-row">
            <div class="count" data-count="${total}">0</div>
            <div class="metric-copy">
              <strong>${rangeCopy}</strong>
              <span>${formatNumber(pageViews)} page views</span>
            </div>
          </div>
          <div class="footer-row">
            <span class="status-dot"></span>
            <span>${data.lastSeenAt ? "Updated continuously" : "Waiting for first visit"}</span>
            <span class="trend ${trendClass}">${trendText}</span>
          </div>
        </section>
      `;

      animateCount(this.shadowRoot.querySelector(".count"), total);
    }

    renderRegions(config, data) {
      const dark = config.mode === "dark";
      const mapData = data.gis || { width: 300, height: 152, continents: [] };
      const valueMode = config.metric;
      const rangeBadge = formatRangeBadge(config, data);
      const showRangeBadge = resolveRangeMode(config, data) !== "all";
      const items = mapData.continents.map((region) => {
        const found = data.breakdown?.find((item) => item.key === region.key);
        const uniqueVisitors = found?.uniqueVisitors || 0;
        return {
          ...region,
          uniqueVisitors,
          share: found?.share || 0,
          strength: uniqueVisitors,
        };
      });
      const peak = Math.max(1, ...items.map((item) => item.uniqueVisitors));
      const top = [...items].sort((a, b) => b.uniqueVisitors - a.uniqueVisitors).slice(0, 4);

      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(config.mode, config.accent)}</style>
        <section class="widget regions-card">
          <div class="header-row">
            <div class="eyebrow">Visitor map</div>
            ${showRangeBadge ? `<div class="regions-meta"><div class="badge">${rangeBadge}</div></div>` : ""}
          </div>
          <svg
            class="map"
            viewBox="0 0 ${mapData.width} ${mapData.height}"
            role="img"
            aria-label="Visitor regions map"
	          >
	            <defs>
	              <linearGradient id="map-grid" x1="0%" x2="100%" y1="0%" y2="100%">
	                <stop offset="0%" stop-color="${dark ? "rgba(111,164,255,0.05)" : "rgba(18,119,107,0.08)"}"></stop>
	                <stop offset="100%" stop-color="${dark ? "rgba(111,164,255,0.00)" : "rgba(18,119,107,0.00)"}"></stop>
	              </linearGradient>
	              <radialGradient id="ocean-wash" cx="50%" cy="44%" r="76%">
	                <stop offset="0%" stop-color="${dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.66)"}"></stop>
	                <stop offset="100%" stop-color="${dark ? "rgba(111,164,255,0.03)" : "rgba(18,119,107,0.05)"}"></stop>
	              </radialGradient>
	              <filter id="continent-glow" x="-20%" y="-20%" width="140%" height="140%">
	                <feGaussianBlur stdDeviation="4"></feGaussianBlur>
              </filter>
            </defs>
            <rect
              x="1"
              y="1"
	              width="${mapData.width - 2}"
	              height="${mapData.height - 2}"
	              rx="20"
	              fill="${dark ? "rgba(28, 34, 48, 0.92)" : "url(#ocean-wash)"}"
	              class="map-shell"
	            ></rect>
            <rect
              x="1"
              y="1"
              width="${mapData.width - 2}"
              height="${mapData.height - 2}"
              rx="20"
              fill="url(#map-grid)"
              class="map-underlay"
            ></rect>
	            ${items
	              .map((item) => {
	                const intensity = clamp(item.uniqueVisitors / peak, 0.1, 1);
	                const fillOpacity = (0.15 + intensity * 0.58).toFixed(3);
	                const glowOpacity = (dark ? 0 : 0.05 + intensity * 0.22).toFixed(3);
	                const ridgeOpacity = (dark ? 0.05 + intensity * 0.08 : 0.14 + intensity * 0.18).toFixed(3);
	                return `
	                  <g
	                    class="map-region"
                    style="--fill-opacity:${fillOpacity}; --glow-opacity:${glowOpacity}; --ridge-opacity:${ridgeOpacity};"
                  >
                    <title>${item.label}: ${formatNumber(item.uniqueVisitors)} visitors (${item.share || 0}%)</title>
                    <path class="map-shadow" d="${item.path}" transform="translate(0 4)"></path>
                    <path class="map-fill" d="${item.path}"></path>
                    <path class="map-ridge" d="${item.path}"></path>
                  </g>
                `;
              })
              .join("")}
          </svg>
          <div class="region-list">
            ${top
              .map((item) => {
                const intensity = clamp(item.uniqueVisitors / peak, 0.18, 1);
                return `
                  <div class="region-item">
                    <span class="region-name">
                      <i style="opacity:${(0.2 + intensity * 0.8).toFixed(3)}"></i>
                      ${item.label}
                    </span>
                    <strong>${
                      valueMode === "count"
                        ? formatNumber(item.uniqueVisitors)
                        : item.share
                          ? `${item.share}%`
                          : "0%"
                    }</strong>
                  </div>
                `;
              })
              .join("")}
          </div>
        </section>
      `;
    }

    renderHorizontal(config, data) {
      const { mapData, items, peak, top } = resolveRegionVisuals(data);
      const valueMode = config.metric;
      const rangeBadge = formatRangeBadge(config, data);
      const showRangeBadge = resolveRangeMode(config, data) !== "all";
      const totalVisitors = items.reduce((sum, item) => sum + (item.uniqueVisitors || 0), 0);
      const summaryValue = formatNumber(totalVisitors);
      const toggleSymbol = valueMode === "count" ? "#" : "%";
      const nextMetric = valueMode === "count" ? "percentage" : "count";
      const nextLabel = nextMetric === "count" ? "count" : "percentage";

      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(config.mode, config.accent)}</style>
        <section class="widget horizontal-card">
          <div class="horizontal-layout">
            <div class="horizontal-map-panel">
              ${renderRegionMapMarkup(mapData, items, peak, config.mode === "dark")}
            </div>
            <div class="horizontal-summary">
              <div class="horizontal-head">
                <div class="horizontal-intro">
                  <div class="eyebrow">Visitors</div>
                  <div class="headline horizontal-total-row">
                    <span class="horizontal-total-value">${summaryValue}</span>
                  </div>
                </div>
                <div class="horizontal-meta">
                  <button
                    class="horizontal-toggle"
                    type="button"
                    data-horizontal-toggle="${nextMetric}"
                    aria-label="Switch to ${nextLabel}"
                    title="Switch to ${nextLabel}"
                  >${toggleSymbol}</button>
                  ${showRangeBadge ? `<div class="badge">${rangeBadge}</div>` : ""}
                </div>
              </div>
              <div class="region-list region-list-inline">
                ${top
                  .map((item) => {
                    const intensity = clamp(item.uniqueVisitors / peak, 0.18, 1);
                    const primaryValue =
                      valueMode === "count"
                        ? formatNumber(item.uniqueVisitors)
                        : item.share
                          ? `${item.share}%`
                          : "0%";
                    return `
                      <div class="region-item region-item-inline">
                        <span class="region-name">
                          <i style="opacity:${(0.2 + intensity * 0.8).toFixed(3)}"></i>
                          ${formatRegionCompactLabel(item)}
                        </span>
                        <strong class="region-value">${primaryValue}</strong>
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            </div>
          </div>
        </section>
      `;

      this.bindHorizontalToggle(config, data);
    }

    renderHeatmap(config, data) {
      const cells = Array.isArray(data.cells) ? data.cells : [];
      const peak = Math.max(1, data.peakUniqueVisitors || 0, ...cells.map((item) => item.uniqueVisitors || 0));
      const rangeBadge = formatRangeBadge(config, data);

      this.shadowRoot.innerHTML = `
        <style>${widgetStyles(config.mode, config.accent)}</style>
        <section class="widget heatmap-card">
          <div class="header-row">
            <div>
              <div class="eyebrow">Activity heatmap</div>
              <div class="headline">Recent traffic rhythm</div>
            </div>
            <div class="badge">${rangeBadge}</div>
          </div>
          <div class="heat-grid-wrap">
            <div class="heat-grid" aria-label="Daily visitor heatmap">
              ${cells
                .map((cell) => {
                  const intensity = clamp((cell.uniqueVisitors || 0) / peak, 0, 1);
                  return `
                    <span
                      class="heat-cell"
                      title="${cell.date}: ${formatNumber(cell.uniqueVisitors || 0)} visitors"
                      style="--level:${intensity.toFixed(3)}"
                    ></span>
                  `;
                })
                .join("")}
            </div>
          </div>
          <div class="footer-row">
            <span>${formatNumber(data.totals?.uniqueVisitors || 0)} unique visitors</span>
            <span class="legend">
              <i></i><i></i><i></i><i></i>
              <em>Low to high</em>
            </span>
          </div>
        </section>
      `;
    }

    bindHorizontalToggle(config, data) {
      const button = this.shadowRoot.querySelector("[data-horizontal-toggle]");
      if (!button) {
        return;
      }

      button.addEventListener("click", () => {
        const nextMetric = normalizeRegionMetric(button.getAttribute("data-horizontal-toggle"));
        if (nextMetric === config.metric) {
          return;
        }

        this.horizontalMetric = nextMetric;
        const nextConfig = { ...config, metric: nextMetric };
        this.latestResolved = { config: nextConfig, data };
        this.renderHorizontal(nextConfig, data);
      });
    }
  }

  if (!customElements.get("visitor-count")) {
    customElements.define("visitor-count", VisitorCountWidget);
  }

  async function withRegionShapes(data) {
    return {
      ...data,
      gis: await cachedJson(GIS_DATA_URL),
    };
  }

  async function resolveDemoData(config) {
    const fallback = buildDemoData(config.widget, config);
    return config.widget === "regions" || config.widget === "horizontal"
      ? withRegionShapes(fallback)
      : fallback;
  }

  function resolveRegionVisuals(data) {
    const mapData = data.gis || { width: 300, height: 152, continents: [] };
    const items = mapData.continents.map((region) => {
      const found = data.breakdown?.find((item) => item.key === region.key);
      return {
        ...region,
        uniqueVisitors: found?.uniqueVisitors || 0,
        share: found?.share || 0,
        strength: found?.uniqueVisitors || 0,
      };
    });

    return {
      mapData,
      items,
      peak: Math.max(1, ...items.map((item) => item.uniqueVisitors)),
      top: [...items].sort((a, b) => b.uniqueVisitors - a.uniqueVisitors).slice(0, 4),
    };
  }

  function renderRegionMapMarkup(mapData, items, peak, dark) {
    return `
      <svg
        class="map"
        viewBox="0 0 ${mapData.width} ${mapData.height}"
        role="img"
        aria-label="Visitor regions map"
      >
        <defs>
          <linearGradient id="map-grid" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="${dark ? "rgba(111,164,255,0.05)" : "rgba(18,119,107,0.08)"}"></stop>
            <stop offset="100%" stop-color="${dark ? "rgba(111,164,255,0.00)" : "rgba(18,119,107,0.00)"}"></stop>
          </linearGradient>
          <radialGradient id="ocean-wash" cx="50%" cy="44%" r="76%">
            <stop offset="0%" stop-color="${dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.66)"}"></stop>
            <stop offset="100%" stop-color="${dark ? "rgba(111,164,255,0.03)" : "rgba(18,119,107,0.05)"}"></stop>
          </radialGradient>
          <filter id="continent-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4"></feGaussianBlur>
          </filter>
        </defs>
        <rect
          x="1"
          y="1"
          width="${mapData.width - 2}"
          height="${mapData.height - 2}"
          rx="20"
          fill="${dark ? "rgba(28, 34, 48, 0.92)" : "url(#ocean-wash)"}"
          class="map-shell"
        ></rect>
        <rect
          x="1"
          y="1"
          width="${mapData.width - 2}"
          height="${mapData.height - 2}"
          rx="20"
          fill="url(#map-grid)"
          class="map-underlay"
        ></rect>
        ${items
          .map((item) => {
            const intensity = clamp(item.uniqueVisitors / peak, 0.1, 1);
            const fillOpacity = (0.15 + intensity * 0.58).toFixed(3);
            const glowOpacity = (dark ? 0 : 0.05 + intensity * 0.22).toFixed(3);
            const ridgeOpacity = (dark ? 0.05 + intensity * 0.08 : 0.14 + intensity * 0.18).toFixed(3);
            return `
              <g
                class="map-region"
                style="--fill-opacity:${fillOpacity}; --glow-opacity:${glowOpacity}; --ridge-opacity:${ridgeOpacity};"
              >
                <title>${item.label}: ${formatNumber(item.uniqueVisitors)} visitors (${item.share || 0}%)</title>
                <path class="map-shadow" d="${item.path}" transform="translate(0 4)"></path>
                <path class="map-fill" d="${item.path}"></path>
                <path class="map-ridge" d="${item.path}"></path>
              </g>
            `;
          })
          .join("")}
      </svg>
    `;
  }

  async function cachedJson(url) {
    if (!SHARED_STATE.requestCache.has(url)) {
      SHARED_STATE.requestCache.set(
        url,
        fetch(url, {
          headers: {
            Accept: "application/json",
          },
          cache: "no-store",
          mode: "cors",
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          return response.json();
        }),
      );
    }

    return SHARED_STATE.requestCache.get(url);
  }

  function trackVisit(config) {
    const key = `${config.apiBase}::${config.siteId}`;
    if (SHARED_STATE.trackedSites.has(key)) {
      return;
    }

    SHARED_STATE.trackedSites.add(key);

    const payload = JSON.stringify({
      visitorId: getVisitorId(),
      path: window.location.pathname,
      referrer: document.referrer,
      title: document.title,
    });
    const targetUrl = new URL("api/track", config.apiBase);
    targetUrl.searchParams.set("token", config.token);
    const target = targetUrl.toString();

    if (navigator.sendBeacon) {
      navigator.sendBeacon(target, payload);
      return;
    }

    fetch(target, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: {
        "content-type": "text/plain;charset=UTF-8",
      },
      body: payload,
    }).catch(() => undefined);
  }

  function getVisitorId() {
    const storageKey = "visitor-count:visitor-id";

    try {
      const existing = localStorage.getItem(storageKey);
      if (existing) {
        return existing;
      }

      const created = self.crypto?.randomUUID
        ? self.crypto.randomUUID().replace(/-/g, "")
        : `vc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(storageKey, created);
      return created;
    } catch {
      if (!window.__visitorCountFallbackId) {
        window.__visitorCountFallbackId = `vc${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 10)}`;
      }

      return window.__visitorCountFallbackId;
    }
  }

  function widgetStyles(mode, accent) {
    const dark = mode === "dark";

    return `
      :host {
        display: block;
        width: min(100%, 360px);
        color: ${dark ? "#f8fafc" : "#112031"};
        font-family: "Space Grotesk", "Avenir Next", "Segoe UI Variable", sans-serif;
      }

      :host([widget="horizontal"]) {
        width: min(100%, 420px);
        height: 100px;
      }

      :host([compact]) {
        width: min(100%, 260px);
      }

      * {
        box-sizing: border-box;
      }

	      .widget {
	        --vc-accent: ${accent};
	        --vc-panel: ${dark ? "#171b22" : "rgba(252, 248, 242, 0.92)"};
	        --vc-edge: ${dark ? "rgba(226, 232, 240, 0.12)" : "rgba(17, 32, 49, 0.08)"};
	        --vc-muted: ${dark ? "rgba(226, 232, 240, 0.72)" : "rgba(17, 32, 49, 0.64)"};
        position: relative;
        overflow: hidden;
	        min-height: 156px;
	        border: 1px solid var(--vc-edge);
	        border-radius: 24px;
	        padding: 18px 18px 16px;
	        background: ${dark
          ? "var(--vc-panel)"
          : "radial-gradient(circle at top right, rgba(18, 119, 107, 0.18), transparent 34%), linear-gradient(160deg, rgba(255, 255, 255, 0.58), transparent 48%), var(--vc-panel)"};
	        box-shadow: ${dark ? "0 10px 24px rgba(0, 0, 0, 0.16)" : "0 18px 60px rgba(15, 23, 42, 0.12)"};
	        backdrop-filter: ${dark ? "none" : "blur(18px)"};
	      }

      :host([compact]) .widget {
        min-height: 0;
        padding: 8px 10px;
        border-radius: 18px;
      }

      .eyebrow {
        margin-bottom: 6px;
        color: var(--vc-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }

      .headline {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        line-height: 1.1;
      }

      .metric-row,
      .header-row,
      .footer-row {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 12px;
      }

      .metric-row {
        align-items: center;
        margin-top: 18px;
      }

      .metric-copy {
        display: grid;
        gap: 4px;
        color: var(--vc-muted);
        font-size: 12px;
      }

      .metric-copy strong {
        color: inherit;
        font-size: 12px;
      }

      .count {
        font-size: clamp(34px, 6vw, 46px);
        font-weight: 700;
        line-height: 0.95;
        letter-spacing: -0.04em;
      }

      .footer-row {
        margin-top: 18px;
        color: var(--vc-muted);
        font-size: 12px;
        align-items: center;
        flex-wrap: wrap;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--vc-accent);
        box-shadow: 0 0 0 6px rgba(18, 119, 107, 0.12);
      }

      .trend {
        margin-left: auto;
        font-weight: 700;
      }

      .trend.up {
        color: #15803d;
      }

      .trend.down {
        color: #b91c1c;
      }

      .orb {
        position: absolute;
        top: -24px;
        right: -8px;
        width: 92px;
        height: 92px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(18, 119, 107, 0.28), rgba(18, 119, 107, 0.02) 68%);
        filter: blur(8px);
      }

      .badge {
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(18, 119, 107, 0.1);
        color: var(--vc-accent);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .regions-meta {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }

      .regions-card .header-row {
        align-items: start;
      }

      :host([compact]) .regions-card .header-row {
        display: none;
      }

      .regions-card .eyebrow {
        margin-bottom: 0;
      }

      .horizontal-card {
        height: 100%;
        min-height: 100%;
        padding: 8px 10px;
      }

      .horizontal-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(170px, 0.95fr);
        gap: 10px;
        align-items: center;
        height: 100%;
      }

      .horizontal-map-panel {
        min-width: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
      }

      .horizontal-map-panel .map {
        width: min(100%, 208px);
        height: 72px;
        margin: 0 auto;
      }

      .horizontal-summary {
        display: grid;
        gap: 0px;
        align-content: center;
        transform: translateY(-2px);
      }

      .horizontal-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
        padding-right: 76px;
      }

      .horizontal-head .eyebrow {
        margin-bottom: 0;
      }

      .horizontal-meta {
        display: inline-flex;
        align-items: start;
        gap: 5px;
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 2;
      }

      .horizontal-toggle {
        appearance: none;
        border: 1px solid ${dark ? "rgba(243, 245, 248, 0.12)" : "rgba(17, 32, 49, 0.08)"};
        width: 30px;
        height: 24px;
        display: inline-grid;
        place-items: center;
        border-radius: 8px;
        background: ${dark ? "rgba(23, 27, 34, 0.92)" : "rgba(255, 255, 255, 0.84)"};
        color: ${dark ? "#f3f5f8" : "#112031"};
        padding: 0;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        line-height: 1;
        cursor: pointer;
        box-shadow: none;
        transition:
          border-color 140ms ease,
          background-color 140ms ease,
          color 140ms ease;
      }

      .horizontal-toggle:hover {
        border-color: ${dark ? "rgba(243, 245, 248, 0.18)" : "rgba(17, 32, 49, 0.14)"};
        background: ${dark ? "rgba(28, 34, 48, 0.98)" : "rgba(255, 255, 255, 0.94)"};
      }

      .horizontal-toggle:focus-visible {
        outline: none;
        border-color: rgba(18, 119, 107, 0.24);
        box-shadow: 0 0 0 3px rgba(18, 119, 107, 0.08);
      }

      .horizontal-intro {
        display: grid;
        gap: 2px;
      }

      .horizontal-total-row {
        margin: 0;
      }

      .horizontal-total-value {
        color: inherit;
        font: inherit;
        letter-spacing: inherit;
        font-variant-numeric: tabular-nums;
      }

      .map {
        display: block;
        width: 100%;
        margin-top: 14px;
      }

      :host([compact]) .map {
        margin-top: 0;
        height: 85px;
      }

      .map-shell {
        stroke: var(--vc-edge);
      }

	      .map-underlay {
	        opacity: ${dark ? "0.24" : "0.72"};
	      }

      .map-shadow {
        fill: var(--vc-accent);
        opacity: var(--glow-opacity, 0.12);
        filter: url(#continent-glow);
      }

      .map-fill {
        fill: var(--vc-accent);
        fill-opacity: var(--fill-opacity, 0.28);
        stroke: rgba(17, 32, 49, 0.12);
        stroke-width: 0.95;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .map-ridge {
        fill: none;
        stroke: rgba(255, 255, 255, var(--ridge-opacity, 0.18));
        stroke-width: 0.75;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .region-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px 14px;
        margin-top: 14px;
      }

      :host([compact]) .region-list {
        display: none;
      }

      .region-item {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        color: var(--vc-muted);
        font-size: 12px;
      }

      .region-name {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .region-name i {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--vc-accent);
        box-shadow: 0 0 0 4px rgba(18, 119, 107, 0.1);
      }

      .region-list-inline {
        display: grid;
        grid-template-columns: repeat(2, auto);
        column-gap: 16px;
        row-gap: 4px;
        justify-content: start;
        align-content: center;
      }

      .region-item-inline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--vc-muted);
        font-size: 11px;
      }

      .region-item-inline .region-name {
        gap: 7px;
        font-size: inherit;
        line-height: 1.2;
        min-width: 0;
        white-space: nowrap;
      }

      .region-item-inline .region-name i {
        width: 7px;
        height: 7px;
      }

      .region-item-inline .region-value {
        color: inherit;
        font-size: inherit;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      .region-item strong {
        color: inherit;
      }

      .heat-grid-wrap {
        margin-top: 16px;
        overflow-x: auto;
        padding-bottom: 2px;
      }

      .heat-grid {
        display: grid;
        grid-auto-flow: column;
        grid-template-rows: repeat(7, 1fr);
        grid-auto-columns: minmax(8px, 1fr);
        gap: 4px;
        min-width: 100%;
      }

      .heat-cell {
        display: block;
        width: 100%;
        aspect-ratio: 1;
        border-radius: 4px;
        border: 1px solid rgba(17, 32, 49, 0.05);
        background: linear-gradient(
          180deg,
          rgba(18, 119, 107, calc(0.08 + var(--level) * 0.82)),
          rgba(18, 119, 107, calc(0.12 + var(--level) * 0.92))
        );
      }

      .legend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .legend i {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: rgba(18, 119, 107, 0.14);
      }

      .legend i:nth-child(2) {
        background: rgba(18, 119, 107, 0.28);
      }

      .legend i:nth-child(3) {
        background: rgba(18, 119, 107, 0.5);
      }

      .legend i:nth-child(4) {
        background: rgba(18, 119, 107, 0.78);
      }

      .legend em {
        font-style: normal;
        color: var(--vc-muted);
      }

      .loading .skeleton {
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(18, 119, 107, 0.08), rgba(18, 119, 107, 0.18), rgba(18, 119, 107, 0.08));
        background-size: 200% 100%;
        animation: pulse 1.4s linear infinite;
      }

      .skeleton.title {
        width: 84px;
        height: 12px;
      }

      .skeleton.metric {
        width: 60%;
        height: 44px;
        margin-top: 20px;
      }

      .skeleton.line {
        width: 100%;
        height: 12px;
        margin-top: 26px;
      }

      .error-state .muted {
        margin-top: 10px;
        color: var(--vc-muted);
        font-size: 13px;
      }

      @keyframes pulse {
        0% {
          background-position: 0 0;
        }
        100% {
          background-position: 200% 0;
        }
      }

      @media (max-width: 520px) {
        :host {
          width: 100%;
        }

        .widget {
          min-height: 148px;
          padding: 16px;
        }

        :host([widget="horizontal"]) {
          height: 100px;
        }

        .region-list {
          grid-template-columns: 1fr;
        }

        .horizontal-layout {
          grid-template-columns: minmax(116px, 0.9fr) minmax(0, 1.1fr);
          gap: 8px;
        }

        .horizontal-summary {
          gap: 0;
          transform: translateY(-1px);
        }

        .horizontal-card {
          min-height: 100%;
          padding: 8px 8px;
        }

        .horizontal-map-panel .map {
          width: min(100%, 160px);
          height: 60px;
        }

        .horizontal-head {
          gap: 8px;
          padding-right: 68px;
        }

        .horizontal-intro {
          gap: 0;
        }

        .horizontal-meta {
          top: 8px;
          right: 6px;
          gap: 4px;
        }

        .horizontal-toggle {
          width: 26px;
          height: 22px;
          font-size: 10px;
        }

        .region-list-inline {
          grid-template-columns: repeat(2, minmax(0, auto));
          column-gap: 10px;
          row-gap: 1px;
        }

        .region-item-inline {
          gap: 6px;
          font-size: 10px;
        }

        .region-item-inline .region-name {
          gap: 5px;
        }

        .region-item-inline .region-name i {
          width: 6px;
          height: 6px;
        }

        :host([compact]) .widget {
          min-height: 0;
        }
      }
    `;
  }

  function buildDemoData(widget, config) {
    const rangeMode = widget === "heatmap" ? "days" : config.rangeMode || "days";
    const days = rangeMode === "all" ? 365 : config.days;

    if (widget === "regions" || widget === "horizontal") {
      return {
        siteId: "demo-site",
        rangeMode,
        rangeDays: rangeMode === "days" ? days : null,
        breakdown: [
          { key: "NA", label: "North America", uniqueVisitors: 6810, share: 38.4 },
          { key: "EU", label: "Europe", uniqueVisitors: 4920, share: 27.8 },
          { key: "AS", label: "Asia", uniqueVisitors: 3910, share: 22.1 },
          { key: "SA", label: "South America", uniqueVisitors: 930, share: 5.2 },
          { key: "AF", label: "Africa", uniqueVisitors: 710, share: 4.0 },
          { key: "OC", label: "Oceania", uniqueVisitors: 460, share: 2.5 },
        ],
      };
    }

    if (widget === "heatmap") {
      const cells = [];

      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        const wave = Math.sin(offset / 5) * 14 + Math.cos(offset / 11) * 7;
        const burst = offset % 13 === 0 ? 22 : 0;
        const uniqueVisitors = Math.max(0, Math.round(28 + wave + burst));
        cells.push({
          date,
          uniqueVisitors,
          pageViews: Math.round(uniqueVisitors * 1.9),
        });
      }

      return {
        siteId: "demo-site",
        rangeMode,
        rangeDays: rangeMode === "days" ? days : null,
        peakUniqueVisitors: Math.max(...cells.map((cell) => cell.uniqueVisitors)),
        totals: {
          uniqueVisitors: Math.round(
            cells.reduce((sum, cell) => sum + cell.uniqueVisitors, 0) * 0.37,
          ),
          pageViews: cells.reduce((sum, cell) => sum + cell.pageViews, 0),
        },
        cells,
      };
    }

    return {
      siteId: "demo-site",
      rangeMode,
      rangeDays: rangeMode === "days" ? days : null,
      lastSeenAt: new Date().toISOString(),
      window: {
        uniqueVisitors: 18472,
        pageViews: 34120,
        trendPct: rangeMode === "all" ? null : 12.4,
      },
    };
  }

  function animateCount(node, value) {
    if (!node) {
      return;
    }

    const duration = 800;
    const start = performance.now();
    const from = 0;

    function step(timestamp) {
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(from + (value - from) * eased);
      node.textContent = formatNumber(current);

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  function isZeroPayload(widget, payload) {
    if (widget === "regions" || widget === "horizontal") {
      return !payload.breakdown?.some((item) => item.uniqueVisitors > 0);
    }

    if (widget === "heatmap") {
      return !payload.cells?.some((item) => item.uniqueVisitors > 0);
    }

    return !payload.window?.uniqueVisitors;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(undefined, {
      notation: value >= 100000 ? "compact" : "standard",
      maximumFractionDigits: value >= 100000 ? 1 : 0,
    }).format(value || 0);
  }

  function readInt(value, fallback) {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function resolveEmbedAccess(config) {
    const token = typeof config.token === "string" ? config.token.trim() : "";
    if (!token) {
      return { ok: false, message: "Embed token required." };
    }

    const payload = normalizeEmbedTokenPayload(config.tokenPayload || readEmbedTokenPayload(token));
    if (!payload) {
      return { ok: false, message: "Invalid embed token." };
    }

    const siteId = normalizeSiteId(config.siteId) || payload.siteId;
    if (!siteId) {
      return { ok: false, message: "site-id is required." };
    }

    if (payload.siteId !== siteId) {
      return { ok: false, message: "Embed token does not match site-id." };
    }

    const currentHost = normalizeHostname(window.location.hostname);
    if (!currentHost || !hostMatchesPattern(currentHost, payload.host)) {
      return { ok: false, message: "Embed token does not allow this host." };
    }

    if (typeof payload.exp === "number" && Date.now() >= payload.exp * 1000) {
      return { ok: false, message: "Embed token expired." };
    }

    return {
      ok: true,
      siteId,
      token,
      payload,
    };
  }

  function readEmbedTokenPayload(token) {
    if (typeof token !== "string") {
      return null;
    }

    const trimmed = token.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      return null;
    }

    try {
      return JSON.parse(base64UrlDecodeToString(parts[1]));
    } catch {
      return null;
    }
  }

  function normalizeEmbedTokenPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const siteId = normalizeSiteId(payload.siteId);
    const host = normalizeHostPattern(payload.host);
    const exp =
      typeof payload.exp === "number" && Number.isFinite(payload.exp)
        ? Math.floor(payload.exp)
        : null;

    if (!siteId || !host) {
      return null;
    }

    return {
      siteId,
      host,
      exp,
    };
  }

  function normalizeSiteId(value) {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(trimmed) ? trimmed : null;
  }

  function normalizeHostPattern(value) {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("*.")) {
      const wildcardHost = normalizeHostname(trimmed.slice(2));
      return wildcardHost ? `*.${wildcardHost}` : null;
    }

    return normalizeHostname(trimmed);
  }

  function normalizeHostname(value) {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "null") {
      return null;
    }

    try {
      const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
      return url.hostname ? url.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function hostMatchesPattern(host, pattern) {
    if (!host || !pattern) {
      return false;
    }

    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }

    return host === pattern;
  }

  function base64UrlDecodeToString(value) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return atob(`${normalized}${padding}`);
  }

  function readRangeConfig(widget, rangeValue, daysValue, fallbackDays) {
    if (widget === "heatmap") {
      return {
        mode: "days",
        days: readInt(daysValue, fallbackDays),
      };
    }

    const normalizedRange = String(rangeValue || "").trim().toLowerCase();

    if (normalizedRange === "all") {
      return { mode: "all", days: null };
    }

    return {
      mode: "days",
      days: readInt(daysValue, fallbackDays),
    };
  }

  function ensureTrailingSlash(value) {
    return value.endsWith("/") ? value : `${value}/`;
  }

  function normalizeRegionMetric(metricValue) {
    const value = (metricValue || "").toLowerCase();
    return value === "count" ? "count" : "percentage";
  }

  function formatRegionCompactLabel(region) {
    const key = typeof region?.key === "string" ? region.key.trim().toUpperCase() : "";
    return key && key !== "OTHER" ? key : region?.label || "Other";
  }

  function resolveRangeMode(config, data) {
    return data?.rangeMode || config.rangeMode || "days";
  }

  function resolveRangeDays(config, data) {
    return data?.rangeDays ?? config.days ?? null;
  }

  function formatRangeBadge(config, data) {
    const mode = resolveRangeMode(config, data);
    const days = resolveRangeDays(config, data);
    return mode === "all" ? "All time" : `${days}d`;
  }

  function formatRangeCopy(config, data) {
    const mode = resolveRangeMode(config, data);
    const days = resolveRangeDays(config, data);
    return mode === "all" ? "All time" : `${days} day window`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
