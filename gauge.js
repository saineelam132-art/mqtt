/**
 * Reusable 270° SVG speedometer-style gauge meter.
 * createGauge(container, { label, min, max, unit, zones }) -> {
 *   setValue(num), showWaiting(), showLocked(), el
 * }
 * zones: [{ from, to, color }] fractions (0..1) of the min..max range,
 * drawn as tinted risk bands under the progress fill.
 *
 * Geometry: min -> -135°/135°, max -> +135°/405°, needle pivots at (100,100).
 */
(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CX = 100;
  const CY = 100;
  const R = 80;
  const STROKE = 14;
  const ANIM_MS = 500;
  const ARC_START = 135; // polar-angle degrees (0°=right, 90°=down, y-down convention)
  const ARC_SPAN = 270;

  let gradientCounter = 0;

  function polar(cx, cy, r, deg) {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, r, start, end) {
    const [sx, sy] = polar(cx, cy, r, start);
    const [ex, ey] = polar(cx, cy, r, end);
    const large = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
  }

  // t in [0,1] -> polar-angle degrees along the 270° sweep.
  function angleAt(t) {
    return ARC_START + t * ARC_SPAN;
  }

  function needleRotation(t) {
    return -135 + t * ARC_SPAN;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3);
  }

  window.createGauge = function createGauge(container, cfg) {
    const { label, min, max, unit, zones } = cfg;
    const gradientId = `gaugeArcGradient-${gradientCounter++}`;

    const card = document.createElement("div");
    card.className = "gauge-card";

    const header = document.createElement("div");
    header.className = "gauge-header";
    const dot = document.createElement("span");
    dot.className = "gauge-dot";
    const labelEl = document.createElement("span");
    labelEl.className = "gauge-label";
    labelEl.textContent = label;
    header.appendChild(dot);
    header.appendChild(labelEl);

    const caption = document.createElement("div");
    caption.className = "gauge-caption";
    caption.textContent = "waiting for data...";

    const svg = svgEl("svg", { class: "gauge-svg", viewBox: "0 0 200 200" });

    const defs = svgEl("defs");
    const gradient = svgEl("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "1", y2: "1" });
    gradient.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#22d3ee" }));
    gradient.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#34d399" }));
    defs.appendChild(gradient);
    svg.appendChild(defs);

    // Base track.
    svg.appendChild(
      svgEl("path", {
        d: arcPath(CX, CY, R, ARC_START, ARC_START + ARC_SPAN),
        stroke: "#1e293b",
        "stroke-width": STROKE,
        fill: "none",
        "stroke-linecap": "round",
      })
    );

    // Risk zone tints.
    zones.forEach((zone) => {
      const path = svgEl("path", {
        d: arcPath(CX, CY, R, angleAt(zone.from), angleAt(zone.to)),
        stroke: zone.color,
        "stroke-width": STROKE,
        "stroke-linecap": "round",
        fill: "none",
        opacity: "0.35",
      });
      svg.appendChild(path);
    });

    // Progress fill, animated 0 -> current value.
    const progressPath = svgEl("path", {
      d: arcPath(CX, CY, R, ARC_START, ARC_START + 0.0001),
      stroke: `url(#${gradientId})`,
      "stroke-width": STROKE,
      "stroke-linecap": "round",
      fill: "none",
    });
    svg.appendChild(progressPath);

    // Tick marks every 10%.
    for (let i = 0; i <= 10; i++) {
      const deg = angleAt(i / 10);
      const [x1, y1] = polar(CX, CY, R, deg);
      const [x2, y2] = polar(CX, CY, R - 8, deg);
      svg.appendChild(svgEl("line", { x1, y1, x2, y2, stroke: "#475569", "stroke-width": 2 }));
    }

    const minLabel = polar(CX, CY, R + 14, ARC_START);
    const maxLabel = polar(CX, CY, R + 14, ARC_START + ARC_SPAN);
    svg.appendChild(svgEl("text", { x: minLabel[0], y: minLabel[1], class: "gauge-tick", "text-anchor": "middle" })).textContent = String(min);
    svg.appendChild(svgEl("text", { x: maxLabel[0], y: maxLabel[1], class: "gauge-tick", "text-anchor": "middle" })).textContent = String(max);

    const needleGroup = svgEl("g", { style: "transform-origin: 100px 100px" });
    needleGroup.appendChild(svgEl("line", { x1: CX, y1: CY, x2: CX, y2: CY - (R - 12), stroke: "#e2e8f0", "stroke-width": 3.5, "stroke-linecap": "round" }));
    needleGroup.appendChild(svgEl("circle", { cx: CX, cy: CY, r: 7, fill: "#e2e8f0" }));
    needleGroup.appendChild(svgEl("circle", { cx: CX, cy: CY, r: 3, fill: "#0f172a" }));
    svg.appendChild(needleGroup);

    const valueText = svgEl("text", { x: CX, y: 150, class: "gauge-value-text", "text-anchor": "middle" });
    valueText.textContent = "—";
    svg.appendChild(valueText);

    const unitText = svgEl("text", { x: CX, y: 168, class: "gauge-unit-text", "text-anchor": "middle" });
    unitText.textContent = unit || "";
    svg.appendChild(unitText);

    card.appendChild(header);
    card.appendChild(caption);
    card.appendChild(svg);
    container.appendChild(card);

    let currentValue = min;
    let rafId = null;

    function render(t) {
      progressPath.setAttribute("d", arcPath(CX, CY, R, ARC_START, ARC_START + Math.max(t, 0.0001) * ARC_SPAN));
      needleGroup.style.transform = `rotate(${needleRotation(t)}deg)`;
    }

    function animateTo(targetValue) {
      const fromValue = currentValue;
      const startTime = performance.now();
      if (rafId) cancelAnimationFrame(rafId);

      function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / ANIM_MS);
        const eased = easeOutCubic(progress);
        const displayValue = fromValue + (targetValue - fromValue) * eased;
        const frac = Math.min(1, Math.max(0, (displayValue - min) / (max - min)));
        render(frac);
        valueText.textContent = displayValue.toFixed(2);
        if (progress < 1) {
          rafId = requestAnimationFrame(step);
        } else {
          currentValue = targetValue;
        }
      }
      rafId = requestAnimationFrame(step);
    }

    return {
      el: card,
      setValue(num) {
        dot.classList.add("live");
        dot.classList.remove("dim");
        caption.classList.add("hidden");
        unitText.classList.remove("hidden");
        animateTo(num);
      },
      showWaiting() {
        if (rafId) cancelAnimationFrame(rafId);
        currentValue = min;
        dot.classList.remove("live");
        dot.classList.add("dim");
        caption.textContent = "waiting for data...";
        caption.classList.remove("hidden", "locked");
        render(0);
        valueText.textContent = "—";
        unitText.classList.add("hidden");
      },
      showLocked() {
        if (rafId) cancelAnimationFrame(rafId);
        currentValue = min;
        dot.classList.remove("live");
        dot.classList.add("dim");
        caption.textContent = "🔒 Locked";
        caption.classList.remove("hidden");
        caption.classList.add("locked");
        render(0);
        valueText.textContent = "🔒";
        unitText.classList.add("hidden");
      },
    };
  };
})();
