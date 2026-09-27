"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A team's own image (a thumbnail or a gallery image) on its own host, in a fixed
 * 16:9 box. If it fails to load (a dead link, or a portal used offline) the
 * fallback shows instead, so a card never shows a broken image. No referrer is
 * sent, so the image host does not learn which page a visitor was on.
 */
export function ProjectImage({ src, alt, fallback, className = "" }: { src: string; alt: string; fallback: ReactNode; className?: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // An image that failed before hydration never reaches onError: ask the browser.
    const img = ref.current;
    if (img?.complete) img.decode().catch(() => setFailed(true));
  }, []);
  if (failed) return <>{fallback}</>;
  return (
    // A plain img: next/image would fetch the team's image through this server.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`block aspect-video w-full bg-face-bg object-cover ${className}`}
    />
  );
}
