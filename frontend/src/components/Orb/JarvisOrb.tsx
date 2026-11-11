/**
 * JarvisOrb — an original glowing particle sphere that shows what the
 * assistant is doing:
 *
 *   idle       slow rotation, soft breathing glow
 *   listening  brighter; the shell swells with your voice
 *   thinking   faster spin with energy pulses travelling across the mesh
 *   speaking   the surface ripples with the assistant's voice
 *
 * Pure canvas 2D (no WebGL, no assets). Points sit on a Fibonacci sphere and
 * nearby points are linked once at start-up, so each frame is just a rotate,
 * project and draw.
 */
import { useEffect, useRef } from 'react';
import { readLevel, type OrbMode } from '../../lib/orb';

interface Props {
  mode: OrbMode;
  size?: number;
  /** Fewer points for small orbs keeps the header version cheap. */
  detail?: 'low' | 'high';
  className?: string;
}

interface ModeStyle {
  hue: number;
  spin: number;
  glow: number;
  pulse: number;
}

const MODES: Record<OrbMode, ModeStyle> = {
  idle: { hue: 190, spin: 0.12, glow: 0.55, pulse: 0 },
  listening: { hue: 185, spin: 0.2, glow: 0.85, pulse: 0 },
  thinking: { hue: 205, spin: 0.55, glow: 0.8, pulse: 1 },
  speaking: { hue: 192, spin: 0.25, glow: 1, pulse: 0 },
};

function fibonacciSphere(n: number): Float32Array {
  const pts = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    pts[i * 3] = Math.cos(t) * r;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = Math.sin(t) * r;
  }
  return pts;
}

function linkNeighbours(pts: Float32Array, n: number, maxDist: number): Uint16Array {
  const links: number[] = [];
  const max2 = maxDist * maxDist;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pts[i * 3] - pts[j * 3];
      const dy = pts[i * 3 + 1] - pts[j * 3 + 1];
      const dz = pts[i * 3 + 2] - pts[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < max2) links.push(i, j);
    }
  }
  return Uint16Array.from(links);
}

export function JarvisOrb({ mode, size = 320, detail = 'high', className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<OrbMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const n = detail === 'high' ? 420 : 140;
    const base = fibonacciSphere(n);
    const links = linkNeighbours(base, n, detail === 'high' ? 0.2 : 0.34);
    const proj = new Float32Array(n * 3); // x, y, depth
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    g.scale(dpr, dpr);

    // Eased style so mode changes blend instead of snapping.
    const cur: ModeStyle = { ...MODES[modeRef.current] };
    let angle = 0;
    let last = performance.now();
    let raf = 0;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = MODES[modeRef.current];
      const k = Math.min(1, dt * 4);
      cur.hue += (target.hue - cur.hue) * k;
      cur.spin += (target.spin - cur.spin) * k;
      cur.glow += (target.glow - cur.glow) * k;
      cur.pulse += (target.pulse - cur.pulse) * k;

      const m = modeRef.current;
      const level = m === 'listening' || m === 'speaking' ? readLevel() : 0;
      const t = now / 1000;
      if (!reduceMotion) angle += dt * cur.spin;

      const c = size / 2;
      const breathe = reduceMotion ? 0 : Math.sin(t * 1.4) * 0.015;
      const radius = size * 0.34 * (1 + breathe + level * 0.12);
      const tilt = 0.35;
      const ca = Math.cos(angle), sa = Math.sin(angle);
      const ct = Math.cos(tilt), st = Math.sin(tilt);

      for (let i = 0; i < n; i++) {
        let x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
        // Voice ripple: displace along the normal with a travelling wave.
        if (level > 0.01 && !reduceMotion) {
          const wave = Math.sin(y * 6 + t * 9) * Math.cos(x * 5 - t * 7);
          const s = 1 + wave * level * 0.16;
          x *= s; y *= s; z *= s;
        }
        const x1 = x * ca + z * sa;
        const z1 = -x * sa + z * ca;
        const y2 = y * ct - z1 * st;
        const z2 = y * st + z1 * ct;
        const persp = 1 / (1.9 - z2 * 0.5);
        proj[i * 3] = c + x1 * radius * persp * 1.6;
        proj[i * 3 + 1] = c + y2 * radius * persp * 1.6;
        proj[i * 3 + 2] = z2;
      }

      g.clearRect(0, 0, size, size);

      // Core glow.
      const hue = cur.hue;
      const core = g.createRadialGradient(c, c, 0, c, c, radius * 1.5);
      const a = 0.18 * cur.glow + level * 0.25;
      core.addColorStop(0, `hsla(${hue}, 95%, 65%, ${a})`);
      core.addColorStop(0.55, `hsla(${hue}, 95%, 55%, ${a * 0.35})`);
      core.addColorStop(1, `hsla(${hue}, 95%, 50%, 0)`);
      g.fillStyle = core;
      g.fillRect(0, 0, size, size);

      g.globalCompositeOperation = 'lighter';

      // Mesh lines, fainter at the back.
      g.lineWidth = 0.6;
      for (let l = 0; l < links.length; l += 2) {
        const i = links[l], j = links[l + 1];
        const depth = (proj[i * 3 + 2] + proj[j * 3 + 2]) / 2;
        let alpha = (0.08 + (depth + 1) * 0.17) * cur.glow;
        if (cur.pulse > 0.01 && !reduceMotion) {
          // Energy pulses sweeping over the sphere while thinking.
          const yy = (base[i * 3 + 1] + 1) / 2;
          const p = Math.max(0, Math.sin(yy * 14 - t * 6));
          alpha += p * p * 0.5 * cur.pulse;
        }
        g.strokeStyle = `hsla(${hue}, 90%, 68%, ${Math.min(0.9, alpha + level * 0.3)})`;
        g.beginPath();
        g.moveTo(proj[i * 3], proj[i * 3 + 1]);
        g.lineTo(proj[j * 3], proj[j * 3 + 1]);
        g.stroke();
      }

      // Nodes.
      for (let i = 0; i < n; i++) {
        const depth = proj[i * 3 + 2];
        const r = (detail === 'high' ? 1.1 : 1.4) * (0.6 + (depth + 1) * 0.45);
        const alpha = (0.25 + (depth + 1) * 0.35) * cur.glow + level * 0.3;
        g.fillStyle = `hsla(${hue}, 100%, 78%, ${Math.min(1, alpha)})`;
        g.beginPath();
        g.arc(proj[i * 3], proj[i * 3 + 1], r, 0, Math.PI * 2);
        g.fill();
      }

      // Thin outer ring.
      g.strokeStyle = `hsla(${hue}, 90%, 70%, ${0.12 * cur.glow + level * 0.25})`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(c, c, radius * 1.32, 0, Math.PI * 2);
      g.stroke();

      g.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, detail]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Assistant is ${mode}`}
    />
  );
}
