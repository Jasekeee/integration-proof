"use client";

import { useEffect, useRef, useState } from "react";
import { buttonSmall } from "../_components/ui";

/**
 * Scenario S3 as an isometric scene: the buyer's phone, the store, a gap, and PayPal's vault. A coin
 * travels to PayPal and is charged, the answer falls into the gap, the store says the payment
 * failed, the buyer pays again, and the store prints a $20 receipt for a $10 cart.
 *
 * The server renders the finished scene, which is what visitors without scripting or with reduced
 * motion see. With motion allowed it plays once, about 8 s, the first time it scrolls into view
 * (globals.css, .seq), and Replay plays it again. Every label is HTML laid over the drawing by
 * percentage, so it stays readable when the drawing scales down.
 */

const W = 960;
const H = 460;
/** Isometric projection: ground x runs down-right, ground y down-left, z up. */
const O = { x: 480, y: 250 };
const iso = (x: number, y: number, z = 0) => ({ x: O.x + (x - y) * 0.866, y: O.y + (x + y) * 0.5 - z });
const pts = (...points: { x: number; y: number }[]) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

/** A box on the ground: its top, its left face (+y) and its right face (+x), in three tones. */
function Box({ gx, gy, w, d, h, tone = "" }: { gx: number; gy: number; w: number; d: number; h: number; tone?: "accent" | "" }) {
  const [x0, x1, y0, y1] = [gx - w / 2, gx + w / 2, gy - d / 2, gy + d / 2];
  const t = tone ? `-${tone}` : "";
  return (
    <g stroke="var(--iso-edge)" strokeWidth={1} strokeLinejoin="round">
      <polygon points={pts(iso(x0, y1, 0), iso(x1, y1, 0), iso(x1, y1, h), iso(x0, y1, h))} fill={`var(--iso-left${t})`} />
      <polygon points={pts(iso(x1, y0, 0), iso(x1, y1, 0), iso(x1, y1, h), iso(x1, y0, h))} fill={`var(--iso-right${t})`} />
      <polygon points={pts(iso(x0, y0, h), iso(x1, y0, h), iso(x1, y1, h), iso(x0, y1, h))} fill={`var(--iso-top${t})`} />
    </g>
  );
}

/** A soft shadow on the ground, cast to the right of a box. */
function Shadow({ gx, gy, w, d }: { gx: number; gy: number; w: number; d: number }) {
  const [x0, x1, y0, y1] = [gx - w / 2 + 14, gx + w / 2 + 26, gy - d / 2 - 6, gy + d / 2 - 2];
  return <polygon points={pts(iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1))} fill="var(--iso-shadow)" />;
}

/** Drawing on a box's left face: local u runs along the face, v runs down from its top edge. */
function onLeftFace(gx: number, gy: number, w: number, d: number, h: number) {
  const corner = iso(gx - w / 2, gy + d / 2, h);
  return `matrix(0.866 0.5 0 1 ${corner.x.toFixed(1)} ${corner.y.toFixed(1)})`;
}

/** A ground tile: the platform a part of the scene stands on. */
function Tile({ gx, gy, w, d }: { gx: number; gy: number; w: number; d: number }) {
  const [x0, x1, y0, y1] = [gx - w / 2, gx + w / 2, gy - d / 2, gy + d / 2];
  const lip = 10;
  return (
    <g stroke="var(--iso-edge)" strokeWidth={1} strokeLinejoin="round">
      <polygon points={pts(iso(x0, y1, 0), iso(x1, y1, 0), iso(x1, y1, -lip), iso(x0, y1, -lip))} fill="var(--iso-left)" />
      <polygon points={pts(iso(x1, y0, 0), iso(x1, y1, 0), iso(x1, y1, -lip), iso(x1, y0, -lip))} fill="var(--iso-right)" />
      <polygon points={pts(iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1))} fill="var(--iso-ground)" />
    </g>
  );
}

/** A coin's flight on an arc: across with one transform, up and down with another. */
function Coin({ from, to, peak, delay, fall = false }: { from: { x: number; y: number }; to: { x: number; y: number }; peak: number; delay: number; fall?: boolean }) {
  const style = {
    "--d": `${delay}s`,
    "--x0": `${from.x}px`,
    "--x1": `${to.x}px`,
    "--y0": `${from.y}px`,
    "--yp": `${peak}px`,
    "--y1": `${to.y}px`,
  } as React.CSSProperties;
  return (
    <g className="coin-x" style={style}>
      <g className={fall ? "coin-fall" : "coin-y"} style={style}>
        <g className="coin" style={style}>
          <ellipse cx={0} cy={0} rx={11} ry={7} fill="var(--accent-fill)" stroke="var(--accent-text)" strokeWidth={1} />
          <ellipse cx={-2} cy={-2} rx={5} ry={2.5} fill="#ffffff" opacity={0.35} />
        </g>
      </g>
    </g>
  );
}

const PHONE = { gx: -190, gy: 190, w: 34, d: 8, h: 66 };
const STORE = { gx: -40, gy: 40, w: 120, d: 96, h: 76 };
const VAULT = { gx: 175, gy: -175, w: 116, d: 116, h: 128 };

const PORTS = {
  phone: iso(PHONE.gx, PHONE.gy, 56),
  store: iso(STORE.gx, STORE.gy, 86),
  vault: iso(VAULT.gx, VAULT.gy, 138),
  gap: { x: 612, y: 470 },
};

function Scene() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
      <Tile gx={-115} gy={115} w={300} d={300} />
      <Tile gx={175} gy={-175} w={200} d={200} />

      {/* The gap between the store and PayPal, with a small cloud over it. */}
      <g fill="var(--iso-cloud)" stroke="var(--iso-edge)" strokeWidth={1}>
        <ellipse cx={604} cy={262} rx={40} ry={18} />
        <ellipse cx={634} cy={250} rx={30} ry={20} />
        <ellipse cx={578} cy={252} rx={26} ry={15} />
      </g>

      <Shadow {...PHONE} />
      <Shadow {...STORE} />
      <Shadow {...VAULT} />

      {/* The buyer's phone, its screen with the Pay button. */}
      <Box {...PHONE} />
      <g transform={onLeftFace(PHONE.gx, PHONE.gy, PHONE.w, PHONE.d, PHONE.h)}>
        <rect x={3} y={4} width={PHONE.w - 6} height={PHONE.h - 8} rx={3} fill="var(--sunken)" />
        <g className="s-tap">
          <rect x={6} y={PHONE.h - 26} width={PHONE.w - 12} height={11} rx={3} fill="var(--accent-fill)" />
        </g>
      </g>

      {/* The store: awning stripes, a door, and the screen that will say the payment failed. */}
      <Box {...STORE} />
      <g transform={onLeftFace(STORE.gx, STORE.gy, STORE.w, STORE.d, STORE.h)}>
        {Array.from({ length: 6 }, (_, i) => (
          <rect key={i} x={i * 20} y={4} width={20} height={14} fill={i % 2 ? "var(--iso-top)" : "var(--accent-fill)"} />
        ))}
        <rect x={0} y={18} width={STORE.w} height={3} fill="var(--iso-shadow)" />
        <rect x={14} y={32} width={28} height={STORE.h - 32} rx={2} fill="var(--iso-right)" stroke="var(--iso-edge)" />
        <rect x={62} y={30} width={44} height={26} rx={3} fill="var(--sunken)" stroke="var(--iso-edge)" />
        <g className="s-flash">
          <rect x={62} y={30} width={44} height={26} rx={3} fill="var(--fail-soft)" stroke="var(--fail)" />
          <path d="M 80 37 L 88 49 M 88 37 L 80 49" stroke="var(--fail)" strokeWidth={2} strokeLinecap="round" />
        </g>
      </g>

      {/* PayPal's vault: a tall server with rows of slots and lights, and a glow when it charges. */}
      <g className="s-glow">
        <ellipse cx={iso(VAULT.gx, VAULT.gy, VAULT.h).x} cy={iso(VAULT.gx, VAULT.gy, VAULT.h).y} rx={120} ry={60} fill="url(#vault-glow)" />
      </g>
      <Box {...VAULT} tone="accent" />
      <g transform={onLeftFace(VAULT.gx, VAULT.gy, VAULT.w, VAULT.d, VAULT.h)}>
        {Array.from({ length: 5 }, (_, i) => (
          <g key={i}>
            <rect x={12} y={18 + i * 21} width={VAULT.w - 24} height={11} rx={2} fill="var(--iso-slot)" />
            <circle cx={VAULT.w - 20} cy={23.5 + i * 21} r={2.2} fill="var(--pass)" />
          </g>
        ))}
      </g>

      <defs>
        <radialGradient id="vault-glow">
          <stop offset="0%" stopColor="var(--accent-fill)" stopOpacity={0.55} />
          <stop offset="100%" stopColor="var(--accent-fill)" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* The coins and the lost answer: hidden at rest, they fly only while the scene plays. */}
      <Coin from={PORTS.phone} to={PORTS.store} peak={150} delay={0.5} />
      <Coin from={PORTS.store} to={PORTS.vault} peak={110} delay={1.35} />
      <Coin from={PORTS.vault} to={PORTS.gap} peak={130} delay={2.95} fall />
      <Coin from={PORTS.phone} to={PORTS.store} peak={150} delay={5.0} />
      <Coin from={PORTS.store} to={PORTS.vault} peak={110} delay={5.85} />
    </svg>
  );
}

/** A label laid over the drawing at a point of the scene. */
function Tag({
  at,
  delay,
  tone = "neutral",
  children,
  below = false,
  className = "",
}: {
  at: { x: number; y: number };
  delay: number;
  tone?: "neutral" | "pass" | "fail" | "muted" | "accent";
  children: React.ReactNode;
  below?: boolean;
  className?: string;
}) {
  const styles = {
    neutral: "border-hairline-2 bg-raised text-foreground",
    pass: "border-[color-mix(in_srgb,var(--pass)_35%,transparent)] bg-pass-bg text-pass",
    fail: "border-[color-mix(in_srgb,var(--fail)_35%,transparent)] bg-fail-bg text-fail",
    muted: "border-hairline-2 bg-raised text-text-2",
    accent: "border-[color-mix(in_srgb,var(--accent-text)_40%,transparent)] bg-accent-soft text-accent-text",
  }[tone];
  return (
    <span
      className={`s-pop pointer-events-none absolute w-max max-w-[11rem] -translate-x-1/2 rounded-full border px-2 py-0.5 text-center text-[10px] font-semibold leading-tight shadow-[inset_0_1px_0_var(--highlight-top)] sm:max-w-none sm:px-2.5 sm:py-1 sm:text-xs ${below ? "" : "-translate-y-full"} ${styles} ${className}`}
      style={{ left: `${(at.x / W) * 100}%`, top: `${(at.y / H) * 100}%`, "--d": `${delay}s` } as React.CSSProperties}
    >
      {children}
    </span>
  );
}

const DESCRIPTION =
  "An illustration of one bad day. The buyer taps Pay $10 on a phone. A coin travels to the store and on to PayPal, and PayPal charges $10. PayPal's response flies back and falls into a gap: the response is lost. The store's screen says: Payment failed. Please try again. The buyer pays again, and PayPal charges $10 again. The store prints a receipt: $20 for a $10 cart. The hardened store asked PayPal and charged $10, once.";

export function BadDay() {
  const ref = useRef<HTMLDivElement>(null);
  /** static: the finished scene; armed: drawn at its start, waiting to be seen; on: playing. */
  const [mode, setMode] = useState<"static" | "armed" | "on">("static");
  const [run, setRun] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let first = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMode("on");
          observer.disconnect();
        } else if (first) {
          setMode("armed");
        }
        first = false;
      },
      { threshold: 0.4 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function replay() {
    setMode("on");
    setRun((count) => count + 1);
  }

  const vaultTop = iso(VAULT.gx, VAULT.gy, VAULT.h);
  const storeTop = iso(STORE.gx, STORE.gy, STORE.h);
  const storeFoot = iso(STORE.gx + STORE.w / 2, STORE.gy + STORE.d / 2, 0);
  return (
    <div className="flex flex-col gap-4">
      <div
        ref={ref}
        key={run}
        className="seq surface-card overflow-hidden rounded-panel px-2 pb-5 pt-3 sm:px-6 sm:pb-7 sm:pt-5"
        data-play={mode === "static" ? undefined : mode}
        role="img"
        aria-label={DESCRIPTION}
      >
        <div className="relative mx-auto aspect-[960/460] w-full max-w-[60rem]">
          <Scene />
          <Tag at={iso(PHONE.gx, PHONE.gy, PHONE.h + 12)} delay={0.2} tone="accent">
            Pay $10
          </Tag>
          <Tag at={{ x: iso(PHONE.gx, PHONE.gy).x, y: iso(PHONE.gx, PHONE.gy).y + 16 }} delay={0} tone="muted" below className="max-sm:hidden">
            Buyer
          </Tag>
          <Tag at={{ x: iso(STORE.gx - 30, STORE.gy + 30).x, y: iso(STORE.gx + STORE.w / 2, STORE.gy + STORE.d / 2).y + 14 }} delay={0} tone="muted" below className="max-sm:hidden">
            Store
          </Tag>
          <Tag at={{ x: iso(VAULT.gx, VAULT.gy).x, y: iso(VAULT.gx + VAULT.w / 2, VAULT.gy + VAULT.d / 2).y + 14 }} delay={0} tone="neutral" below>
            PayPal
          </Tag>
          <Tag at={{ x: vaultTop.x + 60, y: vaultTop.y + 64 }} delay={2.3} tone="pass">
            $10 charged
          </Tag>
          <Tag at={{ x: 588, y: 232 }} delay={3.75} tone="muted">
            × Response lost
          </Tag>
          <Tag at={{ x: storeTop.x - 10, y: storeTop.y - 52 }} delay={4.25} tone="fail" className="max-sm:max-w-[7rem]">
            Payment failed. Please try again.
          </Tag>
          <Tag at={{ x: vaultTop.x - 40, y: vaultTop.y - 52 }} delay={6.75} tone="fail">
            $10 charged
          </Tag>
          {/* The receipt the store prints at the end. */}
          <span
            className="s-print pointer-events-none absolute -translate-x-1/2"
            style={{ left: `${((storeFoot.x + 96) / W) * 100}%`, top: `${((storeFoot.y - 34) / H) * 100}%`, "--d": "7.1s" } as React.CSSProperties}
          >
            <span className="receipt surface-card block rounded-t-md px-2 pb-3 pt-1.5 text-center sm:px-3 sm:pb-4 sm:pt-2">
              <span className="block text-[9px] text-text-3 sm:text-[11px]">Receipt</span>
              <span className="glow-fail-text block whitespace-nowrap text-xs font-semibold text-fail proportional-nums sm:text-base">$20 for a $10 cart</span>
            </span>
          </span>
        </div>
        <p className="s-fade mt-3 text-center text-sm text-pass sm:mt-4 sm:text-base" style={{ "--d": "7.9s" } as React.CSSProperties}>
          <span className="text-text-3">Hardened store:</span> asked PayPal → $10, charged once
        </p>
      </div>
      <button type="button" onClick={replay} className={`${buttonSmall} self-end`}>
        Replay
      </button>
    </div>
  );
}
