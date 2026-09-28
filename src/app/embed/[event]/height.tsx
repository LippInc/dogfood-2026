"use client";

import { useEffect } from "react";

/**
 * Tells the page that embeds this gallery how tall it is, so its iframe needs no scrollbar.
 *
 * The message is exactly { type: "dogfood-embed-height", height: <whole number of pixels> }: a fixed label
 * and one number, never anything read from the page's data or the visitor. It goes to any origin ("*")
 * because the gallery is public and any site may embed it, so the embedding page's origin is not known
 * here; the label lets embed.js tell it from other messages, and embed.js takes it only from its own
 * iframe and the portal's origin, and only when height is a number.
 */
export function ReportHeight() {
  useEffect(() => {
    const send = () => window.parent?.postMessage({ type: "dogfood-embed-height", height: Math.ceil(document.documentElement.scrollHeight) }, "*");
    send();
    const observer = new ResizeObserver(send);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  return null;
}
