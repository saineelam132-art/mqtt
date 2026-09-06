/**
 * Reusable semicircular SVG gauge meter.
 * createGauge(container, { label, min, max, unit, zones }) -> {
 *   setValue(num), showWaiting(), showLocked(), el
 * }
 * zones: [{ from, to, color }] fractions (0..1) of the min..max range.
 */
(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CX = 100;
  const CY = 100;
  const R = 80;
  const STROKE = 14;
  const ANIM_MS = 400;

  function polar(r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) };
  }

  // t in [0,1]: 0 = leftmost (min), 1 = rightmost (max), 0.5 = top.
  function arcPoint(t) {
    return polar(R, 180 - 180 * t);
  }

  function describeArc(t0, t1) {
    const start = arcPoint(t0);
    const end = arcPoint(t1);
    const largeArc = t1 - t0 > 0.5 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${R} ${R} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  function needleAngle(t) {
    return -90 + 180 * t;
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

    const svg = svgEl("svg", { class: "gauge-svg", viewBox: "0 0 200 120" });

    zones.forEach((zone) => {
      const path = svgEl("path", {
        d: describeArc(zone.from, zone.to),
        stroke: zone.color,
        "stroke-width": STROKE,
        "stroke-linecap": "round",
        fill: "none",
        opacity: "0.35",
      });
      svg.appendChild(path);
    });

    const progressPath = svgEl("path", {
      d: describeArc(0, 0),
      stroke: "var(--accent)",
      "stroke-width": STROKE,
      "stroke-linecap": "round",
      fill: "none",
    });
    svg.appendChild(progressPath);

    const minLabel = arcPoint(0);
    const maxLabel = arcPoint(1);
    svg.appendChild(
      svgEl("text", { x: minLabel.x, y: minLabel.y + 16, class: "gauge-tick", "text-anchor": "middle" })
    ).textContent = String(min);
    svg.appendChild(
      svgEl("text", { x: maxLabel.x, y: maxLabel.y + 16, class: "gauge-tick", "text-anchor": "middle" })
    ).textContent = String(max);

    const needleGroup = svgEl("g", { style: "transform-origin: 100px 100px" });
    needleGroup.appendChild(
      svgEl("line", { x1: CX, y1: CY, x2: CX, y2: CY - (R - 6), stroke: "#fff", "stroke-width": 4, "stroke-linecap": "round" })
    );
    needleGroup.appendChild(svgEl("circle", { cx: CX, cy: CY, r: 8, fill: "#fff" }));
    svg.appendChild(needleGroup);

    const valueEl = document.createElement("div");
    valueEl.className = "gauge-value";
    valueEl.textContent = "—";

    const unitEl = document.createElement("div");
    unitEl.className = "gauge-unit";
    unitEl.textContent = unit;

    card.appendChild(header);
    card.appendChild(caption);
    card.appendChild(svg);
    card.appendChild(valueEl);
    card.appendChild(unitEl);
    container.appendChild(card);

    let currentValue = min;
    let rafId = null;

    function render(t) {
      progressPath.setAttribute("d", t > 0 ? describeArc(0, t) : describeArc(0, 0.0001));
      needleGroup.style.transform = `rotate(${needleAngle(t)}deg)`;
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
        valueEl.textContent = displayValue.toFixed(2);
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
        unitEl.classList.remove("hidden");
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
        valueEl.textContent = "—";
        unitEl.classList.add("hidden");
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
        valueEl.textContent = "🔒";
        unitEl.classList.add("hidden");
      },
    };
  };
})();
