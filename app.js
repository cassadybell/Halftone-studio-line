/* Halftone Studio — Line: UI + canvas renderer. */
'use strict';

(function () {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);

  // Value-noise (ported from NoiseSource)
  function hash32(x, y, seed) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h ^ (h >>> 16), 0xBF58476D1CE4E5B9) | 0;
    h = (h ^ (h >>> 16)) | 0;
    h = (h + seed * 0x9E3779B9) | 0;
    return ((h >>> 0) ^ (seed & 0xFFF)) / 4294967296;
  }
  function valueNoise2D(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = x - xi, ty = y - yi;
    const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
    const a = hashNoise(xi, yi, seed), b = hashNoise(xi + 1, yi, seed);
    const c = hashNoise(xi, yi + 1, seed), d = hashNoise(xi + 1, yi + 1, seed);
    const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }
  function noiseLuminance(seed, scale, inverted, w, h) {
    const cells = Math.max(1, scale);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ny = y / h * cells, nx = x / w * cells;
      let v = valueNoise2D(nx, ny, seed);
      if (inverted) v = 1 - v;
      out[y * w + x] = clamp(v, 0, 1);
    }
    return new LuminanceField(w, h, out);
  }

  // -- state / defaults ------------------------------------------------------
  const CTL = ['pattern','source','angle','spacing','minThick','maxThick','contrast',
               'smoothing','brightness','adjContrast','invert'];
  function readState() {
    return {
      pattern: $('pattern').value, source: $('source').value,
      angle: parseFloat($('angle').value), spacing: parseFloat($('spacing').value),
      min: parseFloat($('minThick').value), max: parseFloat($('maxThick').value),
      contrast: parseFloat($('contrast').value), smooth: parseFloat($('smoothing').value),
      bright: parseFloat($('brightness').value), adjC: parseFloat($('adjContrast').value),
      invert: $('invert').checked
    };
  }
  function updateReadouts() { /* values shown in labels are static; optional */ }

  // ---- resize --------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- render --------------------------------------------------------------
  function render() {
    const s = readState();
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 800, H = canvas.clientHeight || 600;

    // luminance field at capped resolution
    const cap = 700;
    const scale = Math.min(1, cap / Math.max(W, H));
    const fw = Math.max(16, Math.floor(W * scale));
    const fh = Math.max(16, Math.floor(H * scale));
    let field;
    if (s.source === 'gradientRadial') field = gradientLuminance('radial', 0, 1, 0, 0.5, 0.5, s.invert, fw, fh);
    else if (s.source === 'noise') field = noiseLuminance(42, 6, s.invert, fw, fh);
    else field = gradientLuminance('linear', 0, 1, 0, 0.5, 0.5, s.invert, fw, fh);

    // brightness/contrast adjustments
    if (s.bright !== 0 || s.adjC !== 1) {
      const vals = field.values;
      for (let i = 0; i < vals.length; i++) {
        vals[i] = clamp((vals[i] - 0.5) * s.adjC + 0.5 + s.bright, 0, 1);
      }
      field = new LuminanceField(field.width, field.height, vals);
    }

    const params = {
      angleDegrees: s.angle, spacing: s.spacing, minThickness: s.min,
      maxThickness: s.max, contrast: s.contrast, smoothing: s.smooth,
      alignment: 'center', pattern: s.pattern,
      distortion: new DistortionParameters(), spiralTurns: 2
    };
    const strokes = LineRasterEngine.generate(field, params, W, H);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const st of strokes) {
      const o = st.outline;
      if (o.length < 3) continue;
      ctx.moveTo(o[0].x, o[0].y);
      for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
    }
    ctx.fill();
  }

  // ---- wiring --------------------------------------------------------------
  document.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });
  $('reset').addEventListener('click', () => {
    const D = {
      pattern: 'parallel', source: 'gradientLinear', angle: 0, spacing: 8.5,
      min: 0, max: 14, contrast: 0.5, smoothing: 0, brightness: 0.44, adjContrast: 1.0,
      invert: false
    };
    $('pattern').value = D.pattern; $('source').value = D.source;
    $('angle').value = D.angle; $('spacing').value = D.spacing;
    $('minThick').value = D.min; $('maxThick').value = D.max;
    $('contrast').value = D.contrast; $('smoothing').value = D.smoothing;
    $('brightness').value = D.brightness; $('adjContrast').value = D.adjContrast;
    $('invert').checked = D.invert;
    render();
  });

  window.addEventListener('resize', () => { resize(); render(); });
  resize();
  render();
})();