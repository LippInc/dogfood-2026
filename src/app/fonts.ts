import localFont from "next/font/local";

// Self-hosted, open-licence fonts (SIL OFL 1.1; each licence sits next to its file
// in src/fonts). Latin subset, variable where the family has an axis.

/** IBM Plex Sans: the interface, with tabular figures. */
export const plex = localFont({
  src: "../fonts/ibm-plex-sans/ibm-plex-sans-latin-wght-normal.woff2",
  variable: "--font-plex",
  weight: "100 700",
  display: "swap",
});

/** Source Serif 4: prose people wrote (descriptions, answers, feedback). */
export const sourceSerif = localFont({
  src: "../fonts/source-serif-4/source-serif-4-latin-wght-normal.woff2",
  variable: "--font-source-serif",
  weight: "200 900",
  display: "swap",
  preload: false,
});

/** JetBrains Mono: ids, times, formulas. */
export const jetbrains = localFont({
  src: "../fonts/jetbrains-mono/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-jetbrains",
  weight: "100 800",
  display: "swap",
});

/** Archivo Black: the public side's display face. */
export const archivo = localFont({
  src: "../fonts/archivo-black/archivo-black-latin-400-normal.woff2",
  variable: "--font-archivo",
  weight: "400",
  display: "swap",
});
