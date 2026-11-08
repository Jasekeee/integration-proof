// A verdict's headline in the words people read: the site's first layer and the CLI's console and
// summary.md. The assertions write the headline when they decide the verdict (lib/proof/assertions),
// stored runs and report.json keep it as written, and the few with a technical word are reworded
// here for display. Every other headline is shown as written.

const PLAIN_HEADLINES: Record<string, string> = {
  "Sale lost on a transient error": "Sale lost on a temporary error",
  "Capture never went through": "Payment never went through",
  "Replay never delivered": "Repeated notice never delivered",
  "Late event never delivered": "Late notice never delivered",
  "Forgery never delivered": "Forged notice never delivered",
  "Forged event accepted": "Forged notice accepted",
  "Forged event changed the order": "Forged notice changed the order",
  "Forged event not rejected": "Forged notice not rejected",
  "Forged event rejected": "Forged notice rejected",
};

export function plainHeadline(headline: string): string {
  return PLAIN_HEADLINES[headline] ?? headline;
}
