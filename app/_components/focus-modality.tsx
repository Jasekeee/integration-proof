"use client";

import { useEffect } from "react";

/** Keys that only scroll the page: after a click they must not light up a focus ring. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Tells the CSS whether the last interaction was the pointer or the keyboard (globals.css hides the
 * ring under data-input="pointer"). Chrome shows :focus-visible on a clicked button as soon as any
 * key is pressed, so scrolling with the arrows after a click drew a ring; here only keys that move
 * focus or act on it bring the ring back: Tab, Enter, and every key inside the trace grid, whose
 * cells are navigated with the arrows. Without JavaScript nothing is marked and the ring stays.
 */
export function FocusModality() {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => {
      root.dataset.input = "pointer";
    };
    const key = (event: KeyboardEvent) => {
      if (root.dataset.input !== "pointer" || event.metaKey || event.ctrlKey || event.altKey) return;
      const inGrid = event.target instanceof Element && event.target.closest(".ag-root-wrapper") !== null;
      if (inGrid || !SCROLL_KEYS.has(event.key)) delete root.dataset.input;
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  return null;
}
