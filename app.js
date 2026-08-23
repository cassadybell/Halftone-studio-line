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

  // -- haptics ----------------------------------------------------------------
  function haptic(type) {
    // iOS Safari exposes navigator.vibrate (iOS 17+); fall back silently.
    if (navigator.vibrate) {
      try {
        if (type === 'tap') navigator.vibrate(10);
        else if (type === 'snap') navigator.vibrate(4);
        else if (type === 'turn') navigator.vibrate([0, 20, 40]);
      } catch (e) {}
    }
  }

  // -- imported-image source -------------------------------------------------
  let importedImage = null;     // { data: Float32Array(w*h), width, height }
  // -- view transform (pinch-zoom + two-finger pan) --------------------------
  let viewScale = 1, viewPanX = 0, viewPanY = 0;
  function imageLuminance(inverted, fw, fh) {
    if (!importedImage) {
      return gradientLuminance('linear', 0, 1, 0, 0.5, 0.5, inverted, fw, fh);
    }
    const W = importedImage.width, H = importedImage.height;
    const out = new Float32Array(fw * fh).fill(1.0);   // white outside source
    // contain/letterbox: fit the image inside the field preserving aspect.
    const sAspect = W / Math.max(1, H);
    const oAspect = fw / Math.max(1, fh);
    let scale, offX = 0, offY = 0;
    if (sAspect >= oAspect) {
      scale = fh / H; offX = (fw - W * scale) / 2;
    } else {
      scale = fw / W; offY = (fh - H * scale) / 2;
    }
    const src = importedImage.data;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const srcX = (x - offX) / scale, srcY = (y - offY) / scale;
        if (srcX >= 0 && srcY >= 0 && srcX < W && srcY < H) {
          const px = Math.min(Math.floor(srcX), W - 1);
          const py = Math.min(Math.floor(srcY), H - 1);
          let l = src[py * W + px];
          if (inverted) l = 1 - l;
          out[y * fw + x] = l;
        }
      }
    }
    return new LuminanceField(fw, fh, out);
  }

  // ---- resize --------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
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
    if (s.source === 'image') field = imageLuminance(s.invert, fw, fh);
    else if (s.source === 'gradientRadial') field = gradientLuminance('radial', 0, 1, 0, 0.5, 0.5, s.invert, fw, fh);
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

    // clear full canvas in device space FIRST
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f0f0f2'; ctx.fillRect(0, 0, W, H);
    // apply view transform (pinch-zoom + pan) to the raster
    ctx.translate(viewPanX, viewPanY);
    ctx.scale(viewScale, viewScale);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const st of strokes) {
      const o = st.outline;
      if (o.length < 3) continue;
      ctx.moveTo(o[0].x, o[0].y);
      for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
    }
    ctx.fill();
    ctx.restore();
  }

  // ---- touch gestures (pinch-zoom, two-finger pan, rotation haptic) ---------
  let lastPinchDist = 0, lastPanX = 0, lastPanY = 0;
  let pinchMode = false, panMode = false;
  canvas.addEventListener('touchstart', e => {
    const t = e.touches;
    if (t.length === 2) {
      pinchMode = true;
      lastPinchDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      lastPanX = (t[0].clientX + t[1].clientX) / 2;
      lastPanY = (t[0].clientY + t[1].clientY) / 2;
    } else {
      pinchMode = false;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    const t = e.touches;
    if (t.length === 2) {
      // pinch: change distance -> zoom
      const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      if (lastPinchDist > 0) {
        const factor = dist / lastPinchDist;
        viewScale = Math.min(8, Math.max(0.25, viewScale * factor));
        haptic('snap');
      }
      lastPinchDist = dist;
      // pan: midpoint movement -> translate
      const mx = (t[0].clientX + t[1].clientX) / 2;
      const my = (t[0].clientY + t[1].clientY) / 2;
      viewPanX += (mx - lastPanX);
      viewPanY += (my - lastPanY);
      lastPanX = mx; lastPanY = my;
      render();
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => {
    // rotation: a single-finger twirl would need angle tracking; for now a
    // two-finger rotate gesture is approximated by haptic feedback.
    haptic('turn');
  });

  // wheel zoom (desktop convenience, mirrors pinch)
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    viewScale = Math.min(8, Math.max(0.25, viewScale * factor));
    render();
  }, { passive: false });

  // ---- wiring --------------------------------------------------------------
  document.querySelectorAll('input[type=range], select').forEach(el => {
    el.addEventListener('input', () => { haptic('snap'); render(); });
    el.addEventListener('change', () => { haptic('snap'); render(); });
  });
  // angle slider = "turning" haptic
  $('angle').addEventListener('input', () => { haptic('turn'); render(); });
  $('invert').addEventListener('change', () => { haptic('tap'); render(); });
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
    viewScale = 1; viewPanX = 0; viewPanY = 0;
    render();
  });

  // import image: button triggers hidden file input
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);          // works on iPad Safari
    const img = document.createElement('img');
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      // decode to luminance via an offscreen canvas
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;     // RGBA bytes (or data().data)
      const lum = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const p = i * 4;
        lum[i] = 0.2126 * (d[p]/255) + 0.7152 * (d[p+1]/255) + 0.0722 * (d[p+2]/255);
      }
      importedImage = { data: lum, width: W, height: H };
      URL.revokeObjectURL(url);
      $('source').value = 'image';
      render();
    };
    img.src = url;
    // reset so the same file can be re-picked
    e.target.value = '';
  });

  window.addEventListener('resize', () => { resize(); render(); });
  resize();
  render();
})();