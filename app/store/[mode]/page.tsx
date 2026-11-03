// Reference store. mode is "naive" or "hardened"; both run side by side.
import { notFound } from "next/navigation";

// Not built yet. A 404 says so; an empty 200 renders as a blank screen.
export default function StorePage() {
  notFound();
}
