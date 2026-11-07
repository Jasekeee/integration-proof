"use client";

// Motion that follows real state: a value that changed while the page was open, a number that
// rolls to its value once it is known, a badge that plays once when it is first seen. Nothing here
// moves on its own, and with reduced motion everything shows its final state at once.
import { useEffect, useRef, useState } from "react";

/** True when the visitor asked for less motion; false on the server. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How many times a value has changed since the component mounted. Zero on the first render, so a
 * page that loads with results already in place animates nothing; each later change counts, and
 * the count can key an element so its entrance animation plays again.
 */
export function useChanges<T>(value: T): number {
  const [state, setState] = useState({ value, changes: 0 });
  if (!Object.is(state.value, value)) {
    const next = { value, changes: state.changes + 1 };
    setState(next);
    return next.changes;
  }
  return state.changes;
}

/**
 * A digit that rolls to its value: a column of the digits 0 to max moves under a one-digit window.
 * With roll, it starts at 0 and rolls up after the first frame; otherwise it stands at the value.
 * Screen readers get the number itself.
 */
export function Odometer({ value, max, roll }: { value: number; max: number; roll: boolean }) {
  const [shown, setShown] = useState(roll ? 0 : value);
  useEffect(() => {
    if (shown === value) return;
    const frame = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(frame);
  }, [shown, value]);
  return (
    <span className="relative inline-block h-[1em] overflow-hidden leading-none">
      <span className="sr-only">{value}</span>
      <span
        aria-hidden="true"
        className="flex flex-col transition-transform duration-600 ease-(--ease-out)"
        style={{ transform: `translateY(-${shown}em)` }}
      >
        {Array.from({ length: max + 1 }, (_, digit) => (
          <span key={digit} className="block h-[1em] leading-none">
            {digit}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Plays an element's entrance once, the first time it scrolls into view. Returns the phase for a
 * data attribute: "still" (final state, no motion), "armed" (waiting, drawn in its start state) or
 * "play". The server and the first render say "still", so without JavaScript nothing is hidden.
 */
export function usePlayOnce<T extends Element>(): [React.RefObject<T | null>, "still" | "armed" | "play"] {
  const ref = useRef<T>(null);
  const [phase, setPhase] = useState<"still" | "armed" | "play">("still");
  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    const arm = requestAnimationFrame(() => setPhase("armed"));
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        // Two frames: the armed state paints first, so the entrance has somewhere to start from.
        requestAnimationFrame(() => requestAnimationFrame(() => setPhase("play")));
      },
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => {
      cancelAnimationFrame(arm);
      observer.disconnect();
    };
  }, []);
  return [ref, phase];
}
