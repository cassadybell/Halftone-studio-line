/* Halftone Studio — LINE engine (port of LineRaster.swift + Distortion.swift +
   LuminanceField.swift + Sources.swift). Browser/Node compatible (no DOM). */
'use strict';

// ---- utils ---------------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---- LuminanceField ------------------------------------------------------
/* Values 0...1 (0=black,1=white), row-major, top-left origin. */
class LuminanceField {
  constructor(width, height, values) {
    this.width = width;
    this.height = height;
    this.values = values.map(v => clamp(v, 0, 1));
  }
  luminance(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.values[y * this.width + x];
  }
  /* Bilinear sample at continuous pixel-space coordinates. */
  sample(x, y) {
    const fx = x - 0.5, fy = y - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const xa = clamp(x0, 0, this.width - 1);
    const ya = clamp(y0, 0, this.height - 1);
    const xb = clamp(x0 + 1, 0, this.width - 1);
    const yb = clamp(y0 + 1, 0, this.height - 1);
    const v00 = this.values[ya * this.width + xa];
    const v10 = this.values[ya * this.width + xb];
    const v01 = this.values[yb * this.width + xa];
    const v11 = this.values[yb * this.width + xb];
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }
  sampleNormalized(nx, ny) {
    const x = clamp(nx, 0, 1) * (this.width - 1);
    const y = clamp(ny, 0, 1) * (this.height - 1);
    return this.sample(x, y);
  }
}
function relLuminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// ---- DistortionParameters ------------------------------------------------
class DistortionParameters {
  constructor(o = {}) {
    this.randomization = o.randomization ?? 0;
    this.waveFrequency = o.waveFrequency ?? 0;
    this.waveAmplitude = o.waveAmplitude ?? 0;
    this.waveAngleDegrees = o.waveAngleDegrees ?? 0;
    this.twistStrength = o.twistStrength ?? 0;
    this.twistFrequency = o.twistFrequency ?? 0;
    this.zigzagAmplitude = o.zigzagAmplitude ?? 0;
    this.zigzagFrequency = o.zigzagFrequency ?? 0;
    this.seed = o.seed ?? 12345;
  }
  get isIdentity() {
    return this.randomization === 0 && this.waveAmplitude === 0 &&
           this.twistStrength === 0 && this.zigzagAmplitude === 0;
  }
}

// 64-bit-safe-ish integer hash → [0,1). Used for distortions.
function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + 1376312589) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x5DEECE66D) + seed;
  h = Math.imul(h ^ (h >>> 16), 0xBF58476D1CE4E5B9);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function triangleWave(x) {
  const f = x - Math.floor(x);
  return 1 - 4 * Math.abs(f - 0.5);
}

const Distortion = {
  displaceLine(p, index, cell, params, cw, ch) {
    const out = { x: p.x, y: p.y };
    if (params.randomization > 0) {
      const jx = (hash01(index, cell * 31, params.seed + 7) - 0.5) * 2;
      const jy = (hash01(index, cell * 31, params.seed + 8) - 0.5) * 2;
      out.x += jx * params.randomization;
      out.y += jy * params.randomization;
    }
    if (params.waveAmplitude > 0 && params.waveFrequency > 0) {
      const rad = params.waveAngleDegrees * Math.PI / 180;
      const wx = Math.cos(rad), wy = Math.sin(rad);
      const axis = (out.x - cw / 2) * wx + (out.y - ch / 2) * wy;
      const px = -wy, py = wx;
      const wave = Math.sin(axis * params.waveFrequency * 0.1) * params.waveAmplitude;
      out.x += px * wave; out.y += py * wave;
    }
    if (params.zigzagAmplitude > 0 && params.zigzagFrequency > 0) {
      const rad = params.waveAngleDegrees * Math.PI / 180;
      const wx = Math.cos(rad), wy = Math.sin(rad);
      const axis = (out.x - cw / 2) * wx + (out.y - ch / 2) * wy;
      const px = -wy, py = wx;
      const zig = triangleWave(axis * params.zigzagFrequency * 0.4);
      out.x += px * zig * params.zigzagAmplitude;
      out.y += py * zig * params.zigzagAmplitude;
    }
    if (params.twistStrength > 0) {
      const cx = cw / 2, cy = ch / 2;
      const dx = out.x - cx, dy = out.y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      let twist = r * params.twistStrength * 0.01;
      if (params.twistFrequency > 0) {
        twist *= Math.sin(r * params.twistFrequency * 0.0008 + 1.0);
      }
      const c = Math.cos(twist), s = Math.sin(twist);
      out.x = cx + dx * c - dy * s;
      out.y = cy + dx * s + dy * c;
    }
    return out;
  }
};

// ---- Gradient source -----------------------------------------------------
function gradientLuminance(kind, fromValue, toValue, angleDegrees, cx, cy, inverted, w, h) {
  const out = new Float32Array(w * h);
  const ax = Math.floor(cx * (w - 1)), ay = Math.floor(cy * (h - 1));
  const rad = angleDegrees * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const maxExtent = Math.sqrt(w * w + h * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v, t;
      if (kind === 'linear') {
        const px = x - w * cx, py = y - h * cy;
        t = (px * dx + py * dy) / maxExtent + 0.5;
        v = fromValue + (toValue - fromValue) * clamp(t, 0, 1);
      } else { // radial
        const dxp = (x - ax) / w, dyp = (y - ay) / h;
        const d = Math.sqrt(dxp * dxp + dyp * dyp) * 2;
        t = d;
        v = fromValue + (toValue - fromValue) * clamp(d, 0, 1);
      }
      let l = inverted ? 1 - v : v;
      out[y * w + x] = clamp(l, 0, 1);
    }
  }
  return new LuminanceField(w, h, out);
}

// ---- Line engine ---------------------------------------------------------
const LINE_STEP = 2.5;

class LineRasterEngine {
  /* Generate variable-width contour strokes. Returns array of {outline: [ {x,y}... ]}. */
  static generate(luminance, params, canvasW, canvasH) {
    const spacing = Math.max(0.5, params.spacing);
    if (!(params.maxThickness > 0)) return [];
    const cw = canvasW, ch = canvasH;
    const cx = cw / 2, cy = ch / 2;
    switch (params.pattern) {
      case 'grid':
      case 'parallel':
        return this.generateLinear(luminance, params, cw, ch, cx, cy, spacing);
      case 'concentricCircle':
      case 'concentricSquare':
      case 'concentricHex':
        return this.generateRings(params.pattern, luminance, params, cw, ch, cx, cy, spacing);
      case 'spiral':
        return this.generateSpiral(luminance, params, cw, ch, cx, cy, spacing);
      case 'honeycomb':
        return this.generateHoneycomb(luminance, params, cw, ch, spacing);
      default:
        return [];
    }
  }

  static generateLinear(lum, params, cw, ch, cx, cy, spacing) {
    const strokes = [];
    const angles = params.pattern === 'grid' ? [0, 90] : [params.angleDegrees];
    for (const angle of angles) {
      const rad = angle * Math.PI / 180;
      const d = { x: Math.cos(rad), y: Math.sin(rad) };
      const n = { x: -Math.sin(rad), y: Math.cos(rad) };
      let margin = params.maxThickness * 1.5;
      if (params.distortion.twistStrength > 0) {
        const diag = Math.sqrt(cw * cw + ch * ch);
        margin += diag * 0.5;
      }
      const corners = [[0, 0], [cw, 0], [0, ch], [cw, ch]];
      let tMin = Infinity, tMax = -Infinity, nMin = Infinity, nMax = -Infinity;
      for (const c of corners) {
        const px = c[0] - cx, py = c[1] - cy;
        const tp = px * d.x + py * d.y;
        const np = px * n.x + py * n.y;
        tMin = Math.min(tMin, tp); tMax = Math.max(tMax, tp);
        nMin = Math.min(nMin, np); nMax = Math.max(nMax, np);
      }
      const tStart = tMin - margin, tEnd = tMax + margin;
      const nStart = Math.floor((nMin - margin) / spacing);
      const nEnd = Math.ceil((nMax + margin) / spacing);
      for (let cell = nStart; cell <= nEnd; cell++) {
        const s = cell * spacing;
        const ref = { x: cx + n.x * s, y: cy + n.y * s };
        const steps = Math.floor((tEnd - tStart) / LINE_STEP) + 1;
        const pts = [];
        for (let i = 0; i < steps; i++) {
          const t = tStart + i * LINE_STEP;
          pts.push({ x: ref.x + d.x * t, y: ref.y + d.y * t });
        }
        const st = this.buildStroke2(pts, cell, params, lum, cw, ch, false);
        if (st) strokes.push(st);
      }
    }
    return strokes;
  }

  static generateRings(pattern, lum, params, cw, ch, cx, cy, spacing) {
    const diagonal = Math.sqrt(cw * cw + ch * ch);
    const maxR = diagonal / 2 + params.maxThickness * 1.5;
    const ringCount = Math.ceil(maxR / spacing) + 1;
    const strokes = [];
    for (let ring = 0; ring < ringCount; ring++) {
      const r = (ring + 0.5) * spacing;
      let pts = [];
      switch (pattern) {
        case 'concentricCircle': {
          const circ = 2 * Math.PI * r;
          const steps = Math.max(8, Math.floor(circ / LINE_STEP));
          for (let i = 0; i <= steps; i++) {
            const a = 2 * Math.PI * i / steps;
            pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
          }
          break;
        }
        case 'concentricHex':
          pts = this.polygonOutline(r, 6, cx, cy, -90);
          break;
        case 'concentricSquare':
          pts = this.polygonOutline(r, 4, cx, cy, -45);
          break;
      }
      const st = this.buildStroke2(pts, ring, params, lum, cw, ch, true);
      if (st) strokes.push(st);
    }
    return strokes;
  }

  static polygonOutline(r, sides, cx, cy, startAngle) {
    const out = [];
    const start = startAngle * Math.PI / 180;
    let first = null;
    for (let v = 0; v < sides; v++) {
      const a0 = start + v * 2 * Math.PI / sides;
      const a1 = start + (v + 1) * 2 * Math.PI / sides;
      const p0 = { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r };
      const p1 = { x: cx + Math.cos(a1) * r, y: cy + Math.sin(a1) * r };
      if (first === null) first = p0;
      const edgeLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const n = Math.max(1, Math.floor(edgeLen / LINE_STEP));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        out.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
      }
    }
    if (first) out.push(first);
    return out;
  }

  static generateHoneycomb(lum, params, cw, ch, spacing) {
    const R = Math.max(spacing, 1.0);
    const sqrt3 = Math.sqrt(3);
    const hPitch = R * sqrt3, vPitch = R * 1.5;
    const strokes = [];
    const cols = Math.ceil(cw / hPitch) + 2;
    const rows = Math.ceil(ch / vPitch) + 2;
    let cell = 0;
    const startX = -hPitch, startY = -vPitch;
    for (let row = 0; row < rows; row++) {
      const y = startY + row * vPitch;
      const offset = (row % 2 === 0) ? 0 : hPitch / 2;
      for (let col = 0; col < cols; col++) {
        const x = startX + col * hPitch + offset;
        const pts = this.polygonOutline(R, 6, x, y, -90);
        const st = this.buildStroke2(pts, cell, params, lum, cw, ch, true);
        if (st) strokes.push(st);
        cell++;
      }
    }
    return strokes;
  }

  static generateSpiral(lum, params, cw, ch, cx, cy, spacing) {
    const diagonal = Math.sqrt(cw * cw + ch * ch);
    const maxR = diagonal / 2;
    const maxTheta = maxR / spacing * 2 * Math.PI;
    const ideal = Math.floor(maxR * maxTheta / LINE_STEP);
    const samples = Math.min(Math.max(400, ideal), 40000);
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const theta = i / samples * maxTheta;
      const r = spacing * theta / (2 * Math.PI);
      pts.push({ x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r });
    }
    const out = [];
    const st = this.buildStroke2(pts, 0, params, lum, cw, ch, false);
    if (st) out.push(st);
    return out;
  }

  static buildStroke2(pts, cell, params, lum, cw, ch, closed) {
    if (pts.length < 4) return null;
    const dist = params.distortion;
    // 1. Distort + compute widths.
    const centerLine = [], widths = [];
    for (let i = 0; i < pts.length; i++) {
      let p = pts[i];
      if (!dist.isIdentity) p = Distortion.displaceLine(p, i, cell, dist, cw, ch);
      const nx = p.x / cw, ny = p.y / ch;
      const ll = lum.sampleNormalized(clamp(nx, 0, 1), clamp(ny, 0, 1));
      let tWeight = 1 - ll;
      if (params.contrast !== 0) {
        const mid = 0.5;
        tWeight = 1 / (1 + Math.exp(-params.contrast * 4 * (tWeight - mid)));
      }
      const thick = params.minThickness + (params.maxThickness - params.minThickness) * clamp(tWeight, 0, 1);
      centerLine.push(p); widths.push(thick);   // NOTE below
    }

    // 2. Smooth widths.
    if (params.smoothing > 0 && widths.length > 3) {
      const win = Math.max(1, Math.floor(widths.length * params.smoothing * 0.15));
      const arr = widths.slice();
      for (let i = 0; i < arr.length; i++) {
        const lo = Math.max(0, i - win), hi = Math.min(arr.length - 1, i + win);
        let sum = 0;
        for (let k = lo; k <= hi; k++) sum += arr[k];
        arr[i] = sum / (hi - lo + 1);
      }
      for (let i = 0; i < widths.length; i++) widths[i] = arr[i];
    }

    // 3. Min-thickness cutoff / floor.
    const cutoff = params.minThickness === 0 ? Math.max(1.0, params.maxThickness * 0.12) : 0.25;
    const floor = Math.min(cutoff, params.maxThickness * 0.02);
    let visWidths = new Array(widths.length).fill(0);
    let anyVisible = false;
    for (let i = 0; i < widths.length; i++) {
      visWidths[i] = widths[i] > cutoff ? widths[i] : floor;
      if (widths[i] > cutoff) anyVisible = true;
    }
    if (!anyVisible) return null;

    // Bridge corner gaps for closed shapes.
    if (closed) {
      const n = visWidths.length;
      const bridge = visWidths.slice();
      for (let i = 0; i < n; i++) {
        if (visWidths[i] <= floor) {
          const prev = visWidths[(i - 1 + n) % n];
          const next = visWidths[(i + 1) % n];
          const hi = Math.max(prev, next);
          if (hi > cutoff) {
            bridge[i] = Math.min(hi, Math.max(cutoff, visWidths[i]));
            bridge[i] = Math.max(bridge[i], cutoff);
          }
        }
      }
      visWidths = bridge;
    }

    // 4. Ribbon via per-edge mitred corners.
    const count = centerLine.length;
    if (count < 3) return null;
    const edgeDir = [], edgeLen = [];
    for (let i = 0; i < count; i++) {
      const a = centerLine[i];
      let b;
      if (closed) b = centerLine[(i + 1) % count];
      else if (i === count - 1) b = centerLine[i];
      else b = centerLine[i + 1];
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      edgeLen.push(len);
      if (len > 0.0001) { dx /= len; dy /= len; }
      edgeDir.push({ x: dx, y: dy });
    }
    function perp(e) { return { x: -e.y, y: e.x }; }
    function miterNormal(i, halfWidth) {
      const inEdge = edgeDir[(i - 1 + count) % count];
      const outEdge = edgeDir[i % count];
      const nIn = perp(inEdge), nOut = perp(outEdge);
      let mx = nIn.x + nOut.x, my = nIn.y + nOut.y;
      const ml = Math.sqrt(mx * mx + my * my);
      if (ml > 0.0001) { mx /= ml; my /= ml; } else { mx = nOut.x; my = nOut.y; }
      const cosHalf = mx * nOut.x + my * nOut.y;
      let len = halfWidth;
      if (cosHalf > 0.0001) len = halfWidth / cosHalf;
      len = Math.min(len, halfWidth * 12);
      return { x: mx * len, y: my * len };
    }
    const halfW = w => w / 2;
    const top = [], bottom = [];
    for (let i = 0; i < count; i++) {
      const wNeighbor = Math.max(visWidths[i],
        Math.max(visWidths[(i - 1 + count) % count], visWidths[(i + 1) % count]));
      const mt = miterNormal(i, halfW(Math.max(visWidths[i], wNeighbor)));
      top.push({ x: centerLine[i].x + mt.x, y: centerLine[i].y + mt.y });
      bottom.push({ x: centerLine[i].x - mt.x, y: centerLine[i].y - mt.y });
    }
    const ribbon = [];
    for (const p of top) ribbon.push(p);
    for (let i = bottom.length - 1; i >= 0; i--) ribbon.push(bottom[i]);
    ribbon.push(ribbon[0]);
    return { outline: ribbon };
  }
}

// ---- exports (CommonJS for headless testing; browser uses globals) -------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clamp, LuminanceField, relLuminance, DistortionParameters, Distortion,
    gradientLuminance, LineRasterEngine
  };
}