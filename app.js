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
      invert: $('invert').checked,
      // distortions
      rand: parseFloat($('rand').value), waveAmp: parseFloat($('waveAmp').value),
      waveFreq: parseFloat($('waveFreq').value), waveAngle: parseFloat($('waveAngle').value),
      twist: parseFloat($('twist').value), twistFreq: parseFloat($('twistFreq').value),
      zigAmp: parseFloat($('zigAmp').value), zigFreq: parseFloat($('zigFreq').value)
    };
  }
  function updateReadouts(s) {
    $('angleV').textContent = s.angle; $('spacingV').textContent = s.spacing;
    $('minV').textContent = s.min; $('maxV').textContent = s.max;
    $('contrastV').textContent = s.contrast; $('smoothV').textContent = s.smooth;
    $('brightV').textContent = s.bright; $('adjContrastV').textContent = s.adjC;
    $('randV').textContent = s.rand; $('waveAV').textContent = s.waveAmp;
    $('waveFV').textContent = s.waveFreq; $('waveAngV').textContent = s.waveAngle;
    $('twistV').textContent = s.twist; $('twistFV').textContent = s.twistFreq;
    $('zigAV').textContent = s.zigAmp; $('zigFV').textContent = s.zigFreq;
  }
  function buildDistortion(s) {
    return new DistortionParameters({
      randomization: s.rand, waveAmplitude: s.waveAmp, waveFrequency: s.waveFreq,
      waveAngleDegrees: s.waveAngle, twistStrength: s.twist, twistFrequency: s.twistFreq,
      zigzagAmplitude: s.zigAmp, zigzagFrequency: s.zigFreq
    });
  }

  // -- haptics ----------------------------------------------------------------
  // iPad Safari: navigator.vibrate is often a silent no-op (no motor for the
  // Vibration API). Web Haptics / contact-haptic API (navigator.haptics) DOES
  // produce Taptic feedback on iOS 17+. Try CHAPI, fall back to Vibration API,
  // and finally a tiny visual flash so gestures ALWAYS give feedback.
  const HAPTIC_MS = { tap: 15, snap: 8, turn: 70 };
  function haptic(type) {
    try {
      const H = typeof navigator !== 'undefined' ? navigator.haptics : undefined;
      if (H && typeof H.impact === 'function') {
        // WebHaptics impact feedback (selection/light/medium/heavy)
        H.impact(type === 'turn' ? 'medium' : 'light');
        return;
      }
      if (H && typeof H.createFeedbackPattern === 'function') {
        const pat = H.createFeedbackPattern(type === 'turn' ? 'impactMedium' : 'impactLight');
        pat && H.startPlaying(pat);
        return;
      }
    } catch (e) {}
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(HAPTIC_MS[type] || 10);
      }
    } catch (e) {}
    visualFlash(type);
  }
  // Visual fallback so gestures give feedback even with no motor.
  function visualFlash() {
    const el = canvas;
    el.style.boxShadow = '0 0 0 2px rgba(58,109,240,0.6)';
    setTimeout(() => { el.style.boxShadow = ''; }, 90);
  }

  // -- imported-image source -------------------------------------------------
  let importedImage = null;     // { data: Float32Array(w*h), width, height }
  // -- view transform (pinch-zoom + two-finger pan + rotation) ------------------
  let viewScale = 1, viewPanX = 0, viewPanY = 0, viewRot = 0;   // viewRot degrees
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
      distortion: buildDistortion(s), spiralTurns: 2
    };
    const strokes = LineRasterEngine.generate(field, params, W, H);
    updateReadouts(s);

    // clear full canvas in device space FIRST
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#f0f0f2'; ctx.fillRect(0, 0, W, H);
    // apply view transform (pinch-zoom + pan + rotation) to the raster
    const cxm = W / 2, cym = H / 2;
    ctx.translate(viewPanX + cxm, viewPanY + cym);
    ctx.rotate(viewRot * Math.PI / 180);
    ctx.scale(viewScale, viewScale);
    ctx.translate(-cxm, -cym);
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

  // ---- export (SVG vector + PNG raster) ------------------------------------
  function buildGeometry(W, H) {
    const s = readState();
    const cap = 1200;
    const scale = Math.min(1, cap / Math.max(W, H));
    const fw = Math.max(16, Math.floor(W * scale));
    const fh = Math.max(16, Math.floor(H * scale));
    let field;
    if (s.source === 'image') field = imageLuminance(s.invert, fw, fh);
    else if (s.source === 'gradientRadial') field = gradientLuminance('radial', 0, 1, 0, 0.5, 0.5, s.invert, fw, fh);
    else if (s.source === 'noise') field = noiseLuminance(42, 6, s.invert, fw, fh);
    else field = gradientLuminance('linear', 0, 1, 0, 0.5, 0.5, s.invert, fw, fh);
    if (s.bright !== 0 || s.adjC !== 1) {
      const vals = field.values;
      for (let i = 0; i < vals.length; i++) vals[i] = clamp((vals[i] - 0.5) * s.adjC + 0.5 + s.bright, 0, 1);
      field = new LuminanceField(field.width, field.height, vals);
    }
    const params = { angleDegrees: s.angle, spacing: s.spacing, minThickness: s.min,
      maxThickness: s.max, contrast: s.contrast, smoothing: s.smooth,
      alignment: 'center', pattern: s.pattern,
      distortion: buildDistortion(s), spiralTurns: 2 };
    return LineRasterEngine.generate(field, params, W, H);
  }

  function exportSVG() {
    const W = 1200, H = 1200, s = readState();
    const strokes = buildGeometry(W, H);
    let d = '';
    for (const st of strokes) {
      const o = st.outline; if (o.length < 3) continue;
      let p = 'M' + o[0].x.toFixed(2) + ' ' + o[0].y.toFixed(2);
      for (let i = 1; i < o.length; i++) p += 'L' + o[i].x.toFixed(2) + ' ' + o[i].y.toFixed(2);
      p += 'Z';
      d += '<path d="' + p + '" fill="' + (s.invert ? '#fff' : '#000') + '"/>';
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<rect width="100%" height="100%" fill="' + (s.invert ? '#000' : '#fff') + '"/>' + d + '</svg>';
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'halftone-line.svg');
    haptic('tap');
  }

  function exportPNG() {
    const W = 1200, H = 1200, s = readState();
    const strokes = buildGeometry(W, H);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = s.invert ? '#000' : '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = s.invert ? '#fff' : '#000';
    g.beginPath();
    for (const st of strokes) {
      const o = st.outline; if (o.length < 3) continue;
      g.moveTo(o[0].x, o[0].y);
      for (let i = 1; i < o.length; i++) g.lineTo(o[i].x, o[i].y);
    }
    g.fill();
    c.toBlob(b => { if (b) downloadBlob(b, 'halftone-line.png'); });
    haptic('tap');
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  // ---- touch gestures (pinch-zoom + rotate + 1/2-finger pan) ----------------
  // Uses passive:false + preventDefault so the PAGE doesn't scroll/zoom when
  // touching the artboard — the artboard "owns" the touch.
  let lastPinchDist = 0, lastAngle = 0, lastPanX = 0, lastPanY = 0;
  let gestureActive = false;

  function midAndAngle(t0, t1) {
    const mx = (t0.clientX + t1.clientX) / 2, my = (t0.clientY + t1.clientY) / 2;
    const ang = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX) * 180 / Math.PI;
    return { mx, my, ang };
  }

  canvas.addEventListener('touchstart', e => {
    if (e.target !== canvas) return;            // only when fingers on the artboard
    const t = e.touches;
    if (t.length === 2) {
      e.preventDefault();
      gestureActive = true;
      const g = midAndAngle(t[0], t[1]);
      lastPinchDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      lastAngle = g.ang;
      lastPanX = g.mx; lastPanY = g.my;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (e.target !== canvas) return;
    const t = e.touches;
    if (t.length === 2) {
      e.preventDefault();                        // stop page scroll/move
      const g = midAndAngle(t[0], t[1]);
      const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      // pinch -> zoom
      if (lastPinchDist > 0) {
        const factor = dist / lastPinchDist;
        viewScale = Math.min(8, Math.max(0.25, viewScale * factor));
      }
      // angle change -> rotate artboard (only when actual turning)
      let dA = g.ang - lastAngle;
      if (dA > 180) dA -= 360; else if (dA < -180) dA += 360;
      viewRot += dA;
      // midpoint movement -> pan
      viewPanX += (g.mx - lastPanX);
      viewPanY += (g.my - lastPanY);
      lastPinchDist = dist; lastAngle = g.ang;
      lastPanX = g.mx; lastPanY = g.my;
      haptic('snap');
      render();
    } else if (t.length === 1 && gestureActive) {
      // one-finger slide after a pinch = continue pan; or a lone one-finger drag = pan
      e.preventDefault();
      viewPanX += (t[0].clientX - lastPanX);
      viewPanY += (t[0].clientY - lastPanY);
      lastPanX = t[0].clientX; lastPanY = t[0].clientY;
      render();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (e.target !== canvas) return;
    if (e.touches.length === 0) {
      gestureActive = false;
      haptic('turn');                            // turning/rotation end feedback
    }
  });

  // One-finger pan alone (start with 1 touch): pan without zoom/rotate.
  canvas.addEventListener('touchstart', oneFingerStart, { passive: false });
  function oneFingerStart(e) {
    if (e.touches.length === 1 && !gestureActive) {
      const t0 = e.touches[0];
      lastPanX = t0.clientX; lastPanY = t0.clientY;
    }
  }
  canvas.addEventListener('touchmove', oneFingerMove, { passive: false });
  function oneFingerMove(e) {
    if (e.touches.length === 1 && !gestureActive) {
      e.preventDefault();
      const t0 = e.touches[0];
      viewPanX += (t0.clientX - lastPanX);
      viewPanY += (t0.clientY - lastPanY);
      lastPanX = t0.clientX; lastPanY = t0.clientY;
      render();
    }
  }

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
  $('exportSvg').addEventListener('click', () => exportSVG());
  $('exportPng').addEventListener('click', () => exportPNG());
  $('reset').addEventListener('click', () => {
    const D = {
      pattern: 'parallel', source: 'gradientLinear', angle: 0, spacing: 8.5,
      min: 0, max: 14, contrast: 0.5, smoothing: 0, brightness: 0.44, adjContrast: 1.0,
      invert: false, rand: 0, waveAmp: 0, waveFreq: 0, waveAngle: 0,
      twist: 0, twistFreq: 0, zigAmp: 0, zigFreq: 0
    };
    $('pattern').value = D.pattern; $('source').value = D.source;
    $('angle').value = D.angle; $('spacing').value = D.spacing;
    $('minThick').value = D.min; $('maxThick').value = D.max;
    $('contrast').value = D.contrast; $('smoothing').value = D.smoothing;
    $('brightness').value = D.brightness; $('adjContrast').value = D.adjContrast;
    $('invert').checked = D.invert;
    $('rand').value = D.rand; $('waveAmp').value = D.waveAmp; $('waveFreq').value = D.waveFreq;
    $('waveAngle').value = D.waveAngle; $('twist').value = D.twist; $('twistFreq').value = D.twistFreq;
    $('zigAmp').value = D.zigAmp; $('zigFreq').value = D.zigFreq;
    viewScale = 1; viewPanX = 0; viewPanY = 0; viewRot = 0;
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