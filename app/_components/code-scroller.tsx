"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A code block that scrolls sideways inside itself. A shadow on the right edge shows while part of
 * the code is hidden there, and one on the left once it is scrolled. With line numbers (`gutter`),
 * the numbers stay put and cast the left shadow themselves. A block that overflows can be focused
 * and scrolled with the arrow keys.
 */
export function CodeScroller({
  label,
  gutter = false,
  className = "",
  children,
}: {
  label: string;
  gutter?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const update = () => {
      const hidden = scroller.scrollWidth - scroller.clientWidth;
      const left = scroller.scrollLeft > 1;
      const right = scroller.scrollLeft < hidden - 1;
      setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // The width changes with the viewport, and the content with fonts loading.
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const overflowing = edges.left || edges.right;
  return (
    <div className={`relative min-w-0 overflow-hidden ${className}`}>
      <div
        ref={ref}
        data-code-scroll=""
        data-scrolled={edges.left ? "" : undefined}
        className="code-scroll overflow-x-auto overscroll-x-contain focus-visible:-outline-offset-2"
        tabIndex={overflowing ? 0 : undefined}
        role={overflowing ? "region" : undefined}
        aria-label={overflowing ? `${label}, scrolls sideways` : undefined}
      >
        {children}
      </div>
      {edges.left && !gutter && (
        <span aria-hidden="true" data-scroll-shadow="left" className="scroll-shadow-left pointer-events-none absolute inset-y-0 left-0 w-6" />
      )}
      {edges.right && (
        <span aria-hidden="true" data-scroll-shadow="right" className="scroll-shadow-right pointer-events-none absolute inset-y-0 right-0 w-8" />
      )}
    </div>
  );
}
