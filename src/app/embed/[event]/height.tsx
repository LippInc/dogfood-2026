"use client";

import { useEffect } from "react";

/** Tells the page that embeds this gallery how tall it is, so its iframe needs no scrollbar. */
export function ReportHeight() {
  useEffect(() => {
    const send = () => window.parent?.postMessage({ type: "dogfood-embed-height", height: document.documentElement.scrollHeight }, "*");
    send();
    const observer = new ResizeObserver(send);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  return null;
}
