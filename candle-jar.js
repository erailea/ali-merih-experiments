(() => {
  'use strict';

  // Configuration and state
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');

  // UI elements
  const elCandleCount = document.getElementById('candleCount');
  const elCandleCountValue = document.getElementById('candleCountValue');
  const elJarDiameter = document.getElementById('jarDiameter');
  const elJarDiameterValue = document.getElementById('jarDiameterValue');
  const elSpeed = document.getElementById('speed');
  const elSpeedValue = document.getElementById('speedValue');
  const elBtnLight = document.getElementById('btnLight');
  const elBtnJar = document.getElementById('btnJar');
  const elBtnReset = document.getElementById('btnReset');
  const elOxygen = document.getElementById('oxygen');
  const elWater = document.getElementById('water');

  const defaults = window.__SIM_DEFAULTS__ || { candleCount: 3, jarDiameterPx: 320, speedMultiplier: 3 };

  // World coordinate system
  const world = {
    width: 960,
    height: 560,
    groundY: 480,
    waterLevel: 520, // y coordinate of water top outside the jar (lower is higher visually)
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  // Simulation state
  let state = {
    candles: [],
    jar: {
      placed: false,
      x: world.width * 0.6,
      y: world.groundY - 10,
      diameter: defaults.jarDiameterPx,
      placeAnim: 0,
    },
    oxygenInside: 1.0, // 1.0 = 21% O2 baseline normalized
    temperatureInside: 1.0, // normalized; cools after jar is placed
    waterRise: 0.0, // 0..1 visual interpolation
    isLit: false,
    speed: defaults.speedMultiplier,
    time: 0,
    basin: {
      waterLevel: 0.6, // 0..1 proportion of basin height filled
      capacityPx: 200, // visual height of basin water for 100%
    }
  };

  function initCandles(count) {
    const spacing = 46;
    state.candles = Array.from({ length: count }).map((_, i) => ({
      x: 0,
      y: world.groundY,
      height: 180 + (i % 2) * 10,
      lit: false,
      flame: 0,
    }));
    layoutCandlesAround(state.jar.x || world.width * 0.5, spacing);
  }

  function layoutCandlesAround(centerX, spacing = 46) {
    const n = state.candles.length;
    const startX = centerX - ((n - 1) * spacing) / 2;
    for (let i = 0; i < n; i++) {
      state.candles[i].x = startX + i * spacing;
    }
  }

  function reset(hard = false) {
    // set jar near center first, then lay out candles around it
    state.jar.x = world.width * 0.5;
    initCandles(parseInt(elCandleCount.value, 10) || defaults.candleCount);
    state.jar.diameter = parseInt(elJarDiameter.value, 10) || defaults.jarDiameterPx;
    state.speed = parseFloat(elSpeed.value) || defaults.speedMultiplier;
    state.isLit = false;
    state.jar.placed = false;
    state.jar.placeAnim = 0;
    state.oxygenInside = 1.0;
    state.temperatureInside = 1.0;
    state.waterRise = 0.0;
    state.time = 0;
    state.basin.waterLevel = 0.6;
    if (hard) fitCanvasToContainer();
    updateUiReadouts();
  }

  function lightCandles() {
    state.isLit = true;
    state.candles.forEach(c => { c.lit = true; });
  }

  function toggleJar() {
    state.jar.placed = !state.jar.placed;
    state.jar.placeAnim = 0;
  }

  // Physics-ish model
  function step(dt) {
    const simDt = dt * state.speed;
    state.time += simDt;

    // Animate jar placement
    if (state.jar.placeAnim < 1 && (state.jar.placed || state.jar.placeAnim > 0)) {
      state.jar.placeAnim = clamp(state.jar.placeAnim + simDt * 2.5, 0, 1);
    }

    // Flame and oxygen dynamics
    const activeFlames = state.candles.filter(c => c.lit).length;
    const insideVolume = Math.PI * Math.pow(state.jar.diameter / 2, 2) * 1; // pseudo volume
    const oxygenUsePerFlame = 0.08; // per second baseline (faster for visualization)
    const oxygenCoolingFactor = state.jar.placed ? 1.0 : 0.15; // if not placed, nearly infinite air, tiny effect

    if (state.isLit) {
      state.candles.forEach(c => {
        const o2Factor = clamp(state.oxygenInside, 0, 1);
        const flicker = 0.7 + Math.random() * 0.6;
        c.flame = lerp(c.flame, c.lit ? flicker * o2Factor : 0, 0.1);
        if (c.lit && state.jar.placed && state.oxygenInside <= 0.03) {
          c.lit = false; // flames die when oxygen too low
        }
      });

      // Consume oxygen if jar is placed; otherwise negligible change
      if (state.jar.placed) {
        const jarFactor = clamp(320 / (state.jar.diameter + 1e-5), 0.5, 1.5);
        state.oxygenInside = clamp(
          state.oxygenInside - activeFlames * oxygenUsePerFlame * simDt * jarFactor,
          0, 1
        );
      } else {
        // open air slowly replenishes to 1
        state.oxygenInside = clamp(lerp(state.oxygenInside, 1, 0.02 * simDt), 0, 1);
      }
    } else {
      state.candles.forEach(c => { c.flame = lerp(c.flame, 0, 0.2); });
    }

    // Temperature model: when jar placed and flames burning, temp rises a bit then falls as O2 drops
    const heatInput = state.jar.placed ? activeFlames * 0.02 : 0;
    state.temperatureInside = clamp(
      state.temperatureInside + (heatInput - 0.015 * (state.temperatureInside - 1)) * simDt,
      0.8, 1.25
    );

    // Water rise model: combination of cooling (pressure drop) and oxygen consumed (moles decrease)
    // We map it to a visual rise ratio 0..1 based on an estimated effect scale and jar volume.
    let targetRise = 0;
    if (state.jar.placed) {
      const oxygenLoss = 1 - state.oxygenInside; // 0..1
      const coolingDrop = clamp(1 - state.temperatureInside, 0, 0.3); // normalized
      const combined = clamp(oxygenLoss * 0.6 + coolingDrop * 0.8, 0, 1);
      targetRise = combined;
    }
    state.waterRise = lerp(state.waterRise, targetRise, 1.2 * simDt);

    // Basin water decreases slowly as jar water increases
    const basinDrain = Math.max(0, state.waterRise - 0) * 0.05 * simDt; // slow drain
    if (state.jar.placed) {
      state.basin.waterLevel = clamp(state.basin.waterLevel - basinDrain, 0.05, 1);
    }

    updateUiReadouts();
  }

  function updateUiReadouts() {
    elOxygen.textContent = `${(state.oxygenInside * 100).toFixed(1)}%`;
    elWater.textContent = `${Math.round(state.waterRise * 100)}%`;
    elCandleCountValue.textContent = String(state.candles.length);
    elJarDiameterValue.textContent = `${state.jar.diameter} px`;
    elSpeedValue.textContent = `${Number(state.speed).toFixed(2)}×`;
  }

  // Rendering
  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawBackground() {
    // light ground with subtle top edge
    ctx.fillStyle = '#e9edf3';
    ctx.fillRect(0, world.groundY, canvas.width, canvas.height - world.groundY);
    ctx.fillStyle = '#d1d5db';
    ctx.fillRect(0, world.groundY - 1, canvas.width, 1);
  }

  function drawCandles() {
    state.candles.forEach(c => {
      // base shadow on light ground
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = '#9aa0a6';
      ctx.beginPath();
      ctx.ellipse(c.x, world.groundY - 2, 12, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();

      // wax (soft warm)
      ctx.fillStyle = '#f6e7cf';
      const w = 16;
      ctx.fillRect(c.x - w / 2, c.y - c.height, w, c.height);
      ctx.strokeStyle = '#ddcdb7';
      ctx.lineWidth = 1;
      ctx.strokeRect(c.x - w / 2 + 0.5, c.y - c.height + 0.5, w - 1, c.height - 1);
      // wick
      ctx.fillStyle = '#111827';
      ctx.fillRect(c.x - 1, c.y - c.height - 8, 2, 8);
      // flame
      if (c.lit || c.flame > 0.01) {
        const fh = 16 + 16 * c.flame;
        const fw = 10 + 6 * c.flame;
        const cx = c.x;
        const cy = c.y - c.height - 16;
        const gradient = ctx.createRadialGradient(cx, cy, 1, cx, cy, fh);
        gradient.addColorStop(0, 'rgba(255, 220, 120, 0.95)');
        gradient.addColorStop(0.6, 'rgba(255, 160, 40, 0.6)');
        gradient.addColorStop(1, 'rgba(255, 80, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.ellipse(cx, cy, fw * 0.5, fh * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function drawJar() {
    const { diameter, placeAnim, placed } = state.jar;
    const r = diameter / 2;
    const x = state.jar.x;
    const yBottom = world.groundY - 2; // jar touches ground
    const rise = easeOutCubic(placeAnim);
    const yTop = yBottom - (placed ? 1 : 0) * (r * 2 + 40) * rise + 100 ;

    if (!placed && placeAnim === 0) {
      return; // hide jar until placed
    }

    // jar glass (soft on light bg)
    ctx.save();
    ctx.strokeStyle = 'rgba(180, 200, 215, 0.35)';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(170, 190, 210, 0.04)';
    ctx.beginPath();
    ctx.roundRect(x - r, yTop, diameter, yBottom - yTop, 14);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // water inside jar (rises)
    if (placed) {
      const insideBottom = yBottom - 2;
      const maxRisePx = Math.min(diameter * 0.9, 200);
      const waterInsideTop = insideBottom - state.waterRise * maxRisePx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - r + 3, yTop + 3, diameter - 6, insideBottom - (yTop + 3));
      ctx.clip();
      ctx.fillStyle = 'rgba(130, 180, 210, 0.22)';
      ctx.fillRect(x - r + 3, waterInsideTop, diameter - 6, insideBottom - waterInsideTop);
      // meniscus
      ctx.fillStyle = 'rgba(160, 200, 225, 0.22)';
      ctx.fillRect(x - r + 3, waterInsideTop - 2, diameter - 6, 2);
      ctx.restore();
    }
  }

  function drawBasin() {
    // wide, shallow glass basin in foreground
    const basinWidth = Math.max(Math.floor(world.width * 0.9), state.candles.length * 46 + 240);
    const basinHeight = 36;
    const centerX = world.width * 0.5;
    const x = Math.floor(centerX - basinWidth / 2);
    const y = world.groundY; // rim sits on ground

    ctx.save();
    const radius = 10;
    ctx.beginPath();
    ctx.roundRect(x, y - basinHeight, basinWidth, basinHeight, radius);

    // clip interior to draw water
    ctx.save();
    ctx.clip();
    const innerPad = 3;
    const usableHeight = basinHeight - innerPad * 2;
    const waterHeight = Math.max(4, state.basin.waterLevel * usableHeight);
    const waterTop = y - innerPad - waterHeight;
    const wg = ctx.createLinearGradient(0, waterTop, 0, y - innerPad);
    wg.addColorStop(0, 'rgba(150, 190, 210, 0.18)');
    wg.addColorStop(1, 'rgba(150, 190, 210, 0.10)');
    ctx.fillStyle = wg;
    ctx.fillRect(x + innerPad, waterTop, basinWidth - innerPad * 2, waterHeight);
    // water surface highlight
    ctx.fillStyle = 'rgba(220, 240, 255, 0.15)';
    ctx.fillRect(x + innerPad, waterTop - 1.5, basinWidth - innerPad * 2, 1.5);
    ctx.restore();

    // subtle glass fill and stroke (lighter on light bg)
    const gg = ctx.createLinearGradient(x, y - basinHeight, x + basinWidth, y);
    gg.addColorStop(0, 'rgba(210, 225, 240, 0.06)');
    gg.addColorStop(1, 'rgba(210, 225, 240, 0.04)');
    ctx.fillStyle = gg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(180, 200, 215, 0.35)';
    ctx.stroke();

    // specular highlight stripe on glass
    ctx.beginPath();
    ctx.rect(x + Math.floor(basinWidth * 0.12), y - basinHeight + 4, 6, basinHeight - 8);
    const hg = ctx.createLinearGradient(0, y - basinHeight, 0, y);
    hg.addColorStop(0, 'rgba(255,255,255,0.12)');
    hg.addColorStop(0.5, 'rgba(255,255,255,0.03)');
    hg.addColorStop(1, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = hg;
    ctx.fill();

    // soft shadow under basin (lighter)
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#bfbfbf';
    ctx.beginPath();
    ctx.ellipse(centerX, y + 6, basinWidth * 0.42, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawRipples() {
    // subtle ripples based on water level outside
    const t = state.time * 0.8;
    const y = world.waterLevel + Math.sin(t) * 1.5;
    ctx.strokeStyle = 'rgba(120,180,220,0.25)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(0, y + i * 8);
      ctx.bezierCurveTo(240, y + i * 8 + Math.sin(t + i) * 2, 720, y + i * 8 + Math.cos(t + i) * 2, canvas.width, y + i * 8);
      ctx.stroke();
    }
  }

  function render() {
    clear();
    drawBackground();
    // background elements: jar first
    drawJar();
    // then candles
    drawCandles();
    // foreground element: basin
    drawBasin();
  }

  // Resize handling
  function fitCanvasToContainer() {
    const wrap = canvas.parentElement;
    const dpi = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = Math.max(420, Math.floor(w * 0.6));
    canvas.width = Math.floor(w * dpi);
    canvas.height = Math.floor(h * dpi);
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
  }

  // RAF loop
  let lastTs = 0;
  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    step(dt);
    render();
    requestAnimationFrame(tick);
  }

  // Wiring
  function wireUi() {
    elCandleCount.addEventListener('input', () => {
      const n = parseInt(elCandleCount.value, 10);
      initCandles(n);
      updateUiReadouts();
    });
    elJarDiameter.addEventListener('input', () => {
      state.jar.diameter = parseInt(elJarDiameter.value, 10);
      updateUiReadouts();
    });
    elSpeed.addEventListener('input', () => {
      state.speed = parseFloat(elSpeed.value);
      updateUiReadouts();
    });
    elBtnLight.addEventListener('click', () => { lightCandles(); });
    elBtnJar.addEventListener('click', () => { toggleJar(); });
    elBtnReset.addEventListener('click', () => { reset(true); });

    window.addEventListener('resize', () => { fitCanvasToContainer(); });
    window.addEventListener('orientationchange', () => { fitCanvasToContainer(); });
  }

  // Initialize
  function boot() {
    // seed from defaults to UI
    if (defaults) {
      if (typeof defaults.candleCount === 'number') elCandleCount.value = String(defaults.candleCount);
      if (typeof defaults.jarDiameterPx === 'number') elJarDiameter.value = String(defaults.jarDiameterPx);
      if (typeof defaults.speedMultiplier === 'number') elSpeed.value = String(defaults.speedMultiplier);
    }
    fitCanvasToContainer();
    reset();
    wireUi();
    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();


