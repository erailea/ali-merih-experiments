/*
  Pepper Scattering — Soft‑Body Canvas Simulation

  A soft lattice of particles (pepper flecks) connected by distance constraints evolves with
  Verlet integration. Pointer input drops a short‑lived “soap pulse” that reduces local
  surface tension by pushing flecks radially outward, mimicking the Marangoni effect.
*/

(() => {
  // Canvas setup
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });

  // UI elements
  const resetBtn = document.getElementById('resetBtn');
  const toggleLinksBtn = document.getElementById('toggleLinksBtn');
  const statsLabel = document.getElementById('stats');

  // Simulation parameters
  const SETTINGS = {
    gridCols: 52,
    gridRows: 34,
    constraintIterations: 3,
    structuralStiffness: 0.35, // distance constraint strength [0..1]
    shearStiffness: 0.25,      // diagonals for stability
    damping: 0.0035,           // global velocity damping per step
    jitterAcceleration: 3.0,   // small random accel to keep motion alive
    gravityY: 0.0,             // near zero; pepper floats on surface
    pulseStrength: 3000,       // impulse magnitude for soap pulse
    pulseSigma: 90,            // Gaussian falloff radius in px
    pulseHalfLifeMs: 650,      // exponential decay half‑life
    borderPadding: 24,         // keep particles away from exact edges
    pepperRadius: 1.9,         // draw size of each fleck
    // Tearing settings
    breakThreshold: 1.8,       // break when distance > rest * threshold
    minWeakThreshold: 1.18,    // never weaken below this threshold
    clickTearRadius: 60,       // weaken springs within this radius of click
    clickInnerBreakRadius: 24, // aggressively tear very close to click
    weakenFactor: 0.85,        // local threshold multiplier during weakening
    weakenDurationMs: 450,     // how long weakening lasts
    tearImpulse: 36,            // separation displacement applied when a spring snaps
    maxBreaksPerStep: 200,     // safety cap per frame
  };

  // State
  let particles = [];
  let constraints = [];
  let pulses = [];
  let showLinks = true;
  let lastTimestamp = 0;
  let accumulatedMs = 0;
  const fixedDt = 1000 / 60; // ms per step

  // Utility helpers
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const randRange = (lo, hi) => lo + Math.random() * (hi - lo);

  class Particle {
    constructor(x, y, pinned = false) {
      this.positionX = x;
      this.positionY = y;
      this.previousX = x + randRange(-0.25, 0.25);
      this.previousY = y + randRange(-0.25, 0.25);
      this.accelX = 0;
      this.accelY = 0;
      this.pinned = pinned;
    }

    addForce(ax, ay) {
      this.accelX += ax;
      this.accelY += ay;
    }

    verletStep(dtSeconds, damping) {
      if (this.pinned) {
        this.previousX = this.positionX;
        this.previousY = this.positionY;
        this.accelX = 0;
        this.accelY = 0;
        return;
      }
      const nextX = this.positionX + (this.positionX - this.previousX) * (1 - damping) + this.accelX * dtSeconds * dtSeconds;
      const nextY = this.positionY + (this.positionY - this.previousY) * (1 - damping) + this.accelY * dtSeconds * dtSeconds;
      this.previousX = this.positionX;
      this.previousY = this.positionY;
      this.positionX = nextX;
      this.positionY = nextY;
      this.accelX = 0;
      this.accelY = 0;
    }
  }

  class DistanceConstraint {
    constructor(particleA, particleB, restLength, stiffness) {
      this.a = particleA;
      this.b = particleB;
      this.rest = restLength;
      this.stiffness = stiffness;
      this.breakThresholdBase = SETTINGS.breakThreshold;
      this.weakUntilTs = 0;
      this.weakThreshold = null;
      this.broken = false;
    }

    getCurrentBreakThreshold(nowTs) {
      if (nowTs <= this.weakUntilTs && this.weakThreshold != null) return this.weakThreshold;
      return this.breakThresholdBase;
    }

    markWeak(tempThreshold, untilTs) {
      // Only strengthen weakening if it's more permissive (lower threshold)
      const clamped = Math.max(tempThreshold, SETTINGS.minWeakThreshold);
      if (this.weakThreshold == null || clamped < this.weakThreshold) {
        this.weakThreshold = clamped;
      }
      this.weakUntilTs = Math.max(this.weakUntilTs, untilTs);
    }

    midpoint() {
      return {
        x: (this.a.positionX + this.b.positionX) * 0.5,
        y: (this.a.positionY + this.b.positionY) * 0.5,
      };
    }

    forceBreak() {
      if (this.broken) return;
      this.broken = true;
      // Apply a separation impulse along the spring direction
      const dx = this.b.positionX - this.a.positionX;
      const dy = this.b.positionY - this.a.positionY;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const nx = dx / dist;
      const ny = dy / dist;
      const push = SETTINGS.tearImpulse;
      if (!this.a.pinned && !this.b.pinned) {
        this.a.positionX -= nx * push * 0.5;
        this.a.positionY -= ny * 0.5 * push;
        this.b.positionX += nx * push * 0.5;
        this.b.positionY += ny * 0.5 * push;
      } else if (this.a.pinned && !this.b.pinned) {
        this.b.positionX += nx * push;
        this.b.positionY += ny * push;
      } else if (!this.a.pinned && this.b.pinned) {
        this.a.positionX -= nx * push;
        this.a.positionY -= ny * push;
      }
    }

    satisfy(nowTs) {
      if (this.broken) return false;
      const dx = this.b.positionX - this.a.positionX;
      const dy = this.b.positionY - this.a.positionY;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const threshold = this.getCurrentBreakThreshold(nowTs);
      if (dist > this.rest * threshold) {
        this.forceBreak();
        return false;
      }

      const diff = (dist - this.rest) / dist;
      const k = this.stiffness;
      // If both are movable, split the correction; if one is pinned, move only the other
      const moveAX = dx * 0.5 * k * diff;
      const moveAY = dy * 0.5 * k * diff;
      if (!this.a.pinned && !this.b.pinned) {
        this.a.positionX += moveAX * 1;
        this.a.positionY += moveAY * 1;
        this.b.positionX -= moveAX * 1;
        this.b.positionY -= moveAY * 1;
      } else if (this.a.pinned && !this.b.pinned) {
        this.b.positionX -= dx * k * diff;
        this.b.positionY -= dy * k * diff;
      } else if (!this.a.pinned && this.b.pinned) {
        this.a.positionX += dx * k * diff;
        this.a.positionY += dy * k * diff;
      }
      return true;
    }
  }

  function buildGrid() {
    particles = [];
    constraints = [];

    const width = canvas.width;
    const height = canvas.height;
    const pad = SETTINGS.borderPadding;
    const gridWidth = width - pad * 2;
    const gridHeight = height - pad * 2;

    const cols = SETTINGS.gridCols;
    const rows = SETTINGS.gridRows;
    const cellW = gridWidth / (cols - 1);
    const cellH = gridHeight / (rows - 1);

    // Create particles in a regular grid
    const particleAt = (i, j) => particles[j * cols + i];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = pad + i * cellW;
        const y = pad + j * cellH;
        // Pin a ring of boundary particles slightly to keep the surface framed
        const isBoundary = i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
        particles.push(new Particle(x, y, isBoundary));
      }
    }

    // Structural (horizontal, vertical) constraints
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (i < cols - 1) {
          const a = particleAt(i, j);
          const b = particleAt(i + 1, j);
          constraints.push(new DistanceConstraint(a, b, cellW, SETTINGS.structuralStiffness));
        }
        if (j < rows - 1) {
          const a = particleAt(i, j);
          const b = particleAt(i, j + 1);
          constraints.push(new DistanceConstraint(a, b, cellH, SETTINGS.structuralStiffness));
        }
        // Shear (diagonal) constraints for stability
        if (i < cols - 1 && j < rows - 1) {
          const a = particleAt(i, j);
          const b = particleAt(i + 1, j + 1);
          constraints.push(new DistanceConstraint(a, b, Math.hypot(cellW, cellH), SETTINGS.shearStiffness));
        }
        if (i > 0 && j < rows - 1) {
          const a = particleAt(i, j);
          const b = particleAt(i - 1, j + 1);
          constraints.push(new DistanceConstraint(a, b, Math.hypot(cellW, cellH), SETTINGS.shearStiffness));
        }
      }
    }
  }

  function resizeCanvasToDisplaySize() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const { clientWidth, clientHeight } = canvas;
    const width = Math.floor(clientWidth * dpr);
    const height = Math.floor(clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGrid();
    }
  }

  function addPulse(x, y, strength = SETTINGS.pulseStrength) {
    pulses.push({
      x,
      y,
      strength,
      sigma: SETTINGS.pulseSigma,
      createdAt: performance.now(),
    });
  }

  function stepSimulation(dtMs) {
    const dtSec = dtMs / 1000;

    // Forces: gravity and small jitter, plus soap pulses
    for (let p of particles) {
      if (!p.pinned) {
        // Gravity
        if (SETTINGS.gravityY !== 0) p.addForce(0, SETTINGS.gravityY);
        // Random micro‑motion to keep flecks lively
        const j = SETTINGS.jitterAcceleration;
        p.addForce(randRange(-j, j), randRange(-j, j));
      }
    }

    // Marangoni-like outward force from pulses (Gaussian falloff, exponential decay)
    const now = performance.now();
    const halfLife = SETTINGS.pulseHalfLifeMs;
    const decayCoef = Math.log(2) / halfLife;
    pulses = pulses.filter(pu => now - pu.createdAt < halfLife * 6); // cull old pulses
    for (let pu of pulses) {
      const age = now - pu.createdAt;
      const decay = Math.exp(-decayCoef * age);
      const base = pu.strength * decay;
      const twoSigma2 = 2 * pu.sigma * pu.sigma;
      for (let p of particles) {
        if (p.pinned) continue;
        const dx = p.positionX - pu.x;
        const dy = p.positionY - pu.y;
        const r2 = dx * dx + dy * dy;
        const falloff = Math.exp(-r2 / twoSigma2);
        const r = Math.sqrt(r2) + 1e-6;
        const ax = (dx / r) * base * falloff;
        const ay = (dy / r) * base * falloff;
        p.addForce(ax, ay);
      }
    }

    // Integrate
    for (let p of particles) {
      p.verletStep(dtSec, SETTINGS.damping);
      // simple bounds to keep everything inside the canvas
      p.positionX = clamp(p.positionX, SETTINGS.borderPadding, canvas.width - SETTINGS.borderPadding);
      p.positionY = clamp(p.positionY, SETTINGS.borderPadding, canvas.height - SETTINGS.borderPadding);
    }

    // Satisfy constraints multiple times for stability, with tearing
    const nowTs = performance.now();
    for (let k = 0; k < SETTINGS.constraintIterations; k++) {
      let breaks = 0;
      for (let i = 0; i < constraints.length; i++) {
        const c = constraints[i];
        if (c.broken) continue;
        const ok = c.satisfy(nowTs);
        if (!ok) {
          breaks++;
          if (breaks >= SETTINGS.maxBreaksPerStep) break;
        }
      }
    }
    // Remove broken constraints
    if (constraints.length) constraints = constraints.filter(c => !c.broken);
  }

  function render() {
    // Clear background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Render subtle ripples for active pulses
    const now = performance.now();
    ctx.save();
    for (let pu of pulses) {
      const age = now - pu.createdAt;
      const life = SETTINGS.pulseHalfLifeMs * 2.5;
      const t = clamp(1 - age / life, 0, 1);
      if (t <= 0) continue;
      const r = pu.sigma * (0.8 + (1 - t) * 1.5);
      const alpha = 0.08 * t;
      const grad = ctx.createRadialGradient(pu.x, pu.y, r * 0.2, pu.x, pu.y, r);
      grad.addColorStop(0, `rgba(0,0,0,${alpha * 0.4})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Draw links (springs)
    if (showLinks) {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c of constraints) {
        ctx.moveTo(c.a.positionX, c.a.positionY);
        ctx.lineTo(c.b.positionX, c.b.positionY);
      }
      ctx.stroke();
    }

    // Draw pepper flecks
    ctx.fillStyle = '#111';
    const r = SETTINGS.pepperRadius;
    for (let p of particles) {
      ctx.beginPath();
      ctx.arc(p.positionX, p.positionY, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // HUD stats
    if (statsLabel) {
      statsLabel.textContent = `${particles.length} particles · ${constraints.length} links`;
    }
  }

  // Main loop (fixed time step)
  function animate(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    accumulatedMs += timestamp - lastTimestamp;
    lastTimestamp = timestamp;
    const maxFrameMs = 1000 / 20; // avoid spiral of death
    accumulatedMs = Math.min(accumulatedMs, maxFrameMs);
    while (accumulatedMs >= fixedDt) {
      stepSimulation(fixedDt);
      accumulatedMs -= fixedDt;
    }
    render();
    requestAnimationFrame(animate);
  }

  // Interaction: click/touch drops soap
  let isPointerDown = false;
  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }
  function weakenConstraintsNear(x, y, aggressive) {
    const now = performance.now();
    const outer = SETTINGS.clickTearRadius;
    const inner = Math.min(SETTINGS.clickInnerBreakRadius, outer);
    const weakThr = SETTINGS.breakThreshold * SETTINGS.weakenFactor;
    for (let c of constraints) {
      if (c.broken) continue;
      const m = c.midpoint();
      const dx = m.x - x;
      const dy = m.y - y;
      const d = Math.hypot(dx, dy);
      if (d <= outer) {
        c.markWeak(weakThr, now + SETTINGS.weakenDurationMs);
        if (aggressive && d <= inner) {
          // If already slightly stretched, snap immediately
          const abx = c.b.positionX - c.a.positionX;
          const aby = c.b.positionY - c.a.positionY;
          const dist = Math.hypot(abx, aby) || 1e-6;
          if (dist > c.rest * 1.22) {
            c.forceBreak();
          } else {
            // Chance to break increases toward center
            const t = 1 - d / inner;
            if (Math.random() < 0.12 + 0.30 * t) c.forceBreak();
          }
        }
      }
    }
  }
  canvas.addEventListener('pointerdown', (e) => {
    isPointerDown = true;
    const { x, y } = canvasPointFromEvent(e);
    addPulse(x, y);
    weakenConstraintsNear(x, y, true);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!isPointerDown) return;
    const { x, y } = canvasPointFromEvent(e);
    addPulse(x, y, SETTINGS.pulseStrength * 0.5);
    weakenConstraintsNear(x, y, false);
  });
  window.addEventListener('pointerup', () => { isPointerDown = false; });
  window.addEventListener('pointercancel', () => { isPointerDown = false; });

  // Buttons & keyboard
  if (resetBtn) resetBtn.addEventListener('click', () => buildGrid());
  if (toggleLinksBtn) toggleLinksBtn.addEventListener('click', () => { showLinks = !showLinks; });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') buildGrid();
    if (e.key === 'l' || e.key === 'L') showLinks = !showLinks;
  });

  // Init
  window.addEventListener('resize', resizeCanvasToDisplaySize);
  resizeCanvasToDisplaySize();
  requestAnimationFrame(animate);
})();


