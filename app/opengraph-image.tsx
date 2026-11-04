// The preview image for shared links: what the product is, in the site's dark palette.
import { ImageResponse } from "next/og";

export const alt = "Integration Proof: prove your PayPal integration survives a bad day";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0a0a0a",
          color: "#ededed",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 36, fontWeight: 600 }}>
          <svg width="56" height="56" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="7" fill="#ededed" />
            <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#0a0a0a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Integration Proof
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.1, maxWidth: 1000 }}>
            Prove your PayPal integration survives a bad day, before your customers find out.
          </div>
          <div style={{ fontSize: 28, color: "#a3a3a3" }}>
            Six failure scenarios in the PayPal sandbox · deterministic verdicts · root cause and fix by Claude
          </div>
        </div>
      </div>
    ),
    size,
  );
}
