#!/usr/bin/env node
// Stability check: finds things on the portal's pages that jump, shake or shift while nothing should move them.
// A dev tool, not part of the image and not a vitest test. No dependencies: Node 24's WebSocket drives a headless
// Chrome of its own (a fresh profile in a temp folder, never your browser) over the DevTools protocol.
//
//   node tools/stability-check.mjs http://localhost:8080 --container <portal container>
//   node tools/stability-check.mjs http://localhost:8080 --sessions data/checker-sessions.toml
//   node tools/stability-check.mjs --self-test          (proves the instrument fails on a page with planted bugs)
//
// For every role (organizer, judge, participant, visitor; the seeded checker sessions give the cookies, read from
// the portal's boot log or its checker-sessions.toml) and every width (1440 and 390 px), it crawls the pages that
// role can reach from "/" by links (one URL per route of src/app, per role), and on each page:
//   load      layout shifts after the page first painted (PerformanceObserver "layout-shift")
//   idle      waits, without input, through one live refresh on pages that refresh themselves ("Live")
//   hover     hovers links, buttons, rows and cards
//   menus     opens and closes every menu, dialog and disclosure (aria-haspopup, aria-expanded), Escape to close
//   typing    types a few words, with pauses, into every text field (and puts the old value back)
//   scenario  page flows people run: on the judge console, score every criterion with the keyboard, press C
//             and type feedback straight away (the ranking once shook while a judge typed)
// While each step runs, every visible element's position is sampled on every animation frame. It reports an
// element that moved while nothing should have moved it: during typing into another field, a hover, idle time or
// a refresh with unchanged data, or more than GRACE ms after the click or key that legitimately set it moving.
// "jitter" = it moved in two or more bursts or went back and forth; "shift" = it moved once and stayed.
// Opening an overlay (dialog, menu, listbox) may not move anything outside it; opening a disclosure may push
// down what is below it and nothing else.
//
// Options:
//   --container <name>   read the checker cookies from `docker logs <name>`
//   --sessions <file>    ...or from a checker-sessions.toml / a saved boot log
//   --roles a,b          organizer,judge,participant,visitor (default all; judge = judge_a)
//   --widths 1440,390    viewport widths (heights 900 and 844)
//   --only <regex>       only pages whose path matches
//   --phases a,b         load,idle,hover,menus,typing,scenario (default all)
//   --max-pages <n>      per role (default 40)
//   --jobs <n>           browsers in parallel, one role and width each (default 2)
//   --json <file>        write every finding and the pages visited as JSON
//   --allow <file>       JSON list of accepted motions [{ "page": regex, "phase": "...", "element": regex, "why": "..." }]
//                        (default tools/stability-allow.json when it exists); each needs a reason
//   --chrome <path>      Chrome or Chromium to run (default: $CHROME_PATH, Playwright's Chromium, installed Chrome)
//   --dark               prefers-color-scheme: dark
//   --verbose            print each page and step as it runs
// Exit 0 = nothing moved; 1 = findings (printed, grouped by page and element); 2 = the tool itself failed.
// Opt an element out (a deliberate ticker, a video) with the attribute data-stability-ignore.
// A run writes: a judge's scores and feedback are changed and put back only partly (feedback yes, scores no), so
// run it on a scratch portal, never on one with real data.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const GRACE = 800; // ms a click or key press may keep things moving (the longest intended motion is 320 ms)
const MIN_MOVE = 1.5; // px; smaller displacements (sub-pixel rounding, a scale "stamp" on a pressed button) are ignored
const TURN = 1; // px; a step back smaller than this is rounding, not a turn
const CAUSE_LAG = 150; // ms from a click or key to the first frame it moves (a render and a layout effect)
const SIZES = { 1440: 900, 390: 844 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------------------------
// The in-page instrument. Serialized with toString() and installed before any page script runs.
// ---------------------------------------------------------------------------------------------------------------
function instrument() {
  if (window.__stab) return;
  const S = (window.__stab = { shifts: [], refs: [], session: null, scrolls: [] });
  const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);

  function selector(el) {
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 5; depth++) {
      let p = n.tagName.toLowerCase();
      if (n.id && !/^(radix|_r_|:r)/.test(n.id)) {
        parts.unshift(`${p}#${n.id}`);
        break;
      }
      const attrs = ["data-flip", "name", "aria-label", "role", "data-slot"];
      const a = attrs.find((x) => n.getAttribute(x));
      if (a) p += `[${a}="${n.getAttribute(a).slice(0, 40)}"]`;
      else {
        const cls = [...n.classList].filter((c) => /^[a-z][a-z0-9-]*$/i.test(c) && c.length < 24).slice(0, 2);
        if (cls.length) p += "." + cls.join(".");
      }
      const par = n.parentElement;
      if (par) {
        const same = [...par.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(p);
      if (/^(MAIN|HEADER|NAV|ASIDE|FOOTER|BODY|ARTICLE|FORM|DIALOG)$/.test(n.tagName)) break;
      n = par;
    }
    return parts.join(" > ");
  }
  function label(el) {
    if (el.nodeType !== 1) el = el.parentElement;
    if (!el) return "";
    const t =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        ? el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.id
        : el.getAttribute("aria-label") || el.innerText || el.textContent || el.getAttribute("alt") || "";
    return String(t).replace(/\s+/g, " ").trim().slice(0, 70);
  }
  S.describe = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el ? { sel: selector(el), text: label(el) } : null;
  };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        S.shifts.push({
          t: e.startTime,
          value: e.value,
          recent: e.hadRecentInput,
          sources: (e.sources || []).map((s) => ({ ...(S.describe(s.node) || { sel: "(gone)", text: "" }), prev: rect(s.previousRect), cur: rect(s.currentRect) })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    S.noLayoutShift = true;
  }
  addEventListener("scroll", () => S.scrolls.push(performance.now()), { capture: true, passive: true });

  const TRACK = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|IMG|SVG|LI|TR|TD|TH|VIDEO|CANVAS|LABEL|H1|H2|H3|H4|P|SUMMARY|FIGURE)$/;
  function visible(el, margin) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < -margin || r.top > innerHeight + margin || r.right < 0 || r.left > innerWidth) return false;
    return true;
  }
  function ambient() {
    // Elements under an animation that never ends (a spinner, a pulse): excluded, they move by design.
    const out = [];
    for (const a of document.getAnimations()) {
      try {
        if (a.effect && a.effect.getTiming().iterations === Infinity && a.effect.target) out.push(a.effect.target);
      } catch {
        /* a pseudo-element target */
      }
    }
    return out;
  }
  function candidates(margin) {
    const amb = ambient();
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.ownerSVGElement) continue;
      const tag = el.tagName.toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || tag === "NOSCRIPT") continue;
      const direct = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!direct && !TRACK.test(tag) && !el.hasAttribute("role") && !el.hasAttribute("data-flip")) continue;
      if (!visible(el, margin)) continue;
      if (el.closest("[data-stability-ignore]")) continue;
      if (amb.some((a) => a === el || a.contains(el))) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0") continue;
      out.push(el);
      if (out.length >= 2500) break;
    }
    return out;
  }
  const ownText = (el) => {
    let t = "";
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.data;
    return t;
  };
  // Where an element is drawn: its own first line of text when it has one (text can move inside a box that stays
  // put, like a heading that gains a word in front), else its box.
  const range = document.createRange();
  const pos = (el) => {
    if (!el.isConnected) return null;
    for (const c of el.childNodes) {
      if (c.nodeType !== 3 || !c.data.trim()) continue;
      range.selectNodeContents(c);
      const t = range.getClientRects()[0];
      if (t && (t.width || t.height)) return [t.left + scrollX, t.top + scrollY];
      break;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return [r.left + scrollX, r.top + scrollY];
  };
  const moved = (cs) => cs.transform !== "none" || (cs.translate && cs.translate !== "none") || (cs.scale && cs.scale !== "none") || (cs.rotate && cs.rotate !== "none");
  function transformedBetween(el, top) {
    // Is this element (or an ancestor up to and including `top`) drawn through a transform, or animating, right now?
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (moved(getComputedStyle(n)) || (top && n.getAnimations().length)) return true;
      if (n === top) break;
    }
    return false;
  }

  S.ref = (el) => S.refs.push(el) - 1;
  S.center = (i) => {
    const el = S.refs[i];
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const x = Math.min(innerWidth - 2, Math.max(1, r.left + Math.min(r.width / 2, 40)));
    const y = r.top + r.height / 2;
    if (y < 1 || y > innerHeight - 2) return { x, y, inView: false };
    const hit = document.elementFromPoint(x, y);
    return { x, y, inView: true, reachable: Boolean(hit && (hit === el || el.contains(hit))) };
  };
  S.scrollTo = (i) => {
    const el = S.refs[i];
    if (el && el.isConnected) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  };

  S.settle = (quiet = 600, max = 6000) =>
    new Promise((resolve) => {
      const els = candidates(200).slice(0, 1200);
      let last = els.map(pos);
      let sx = scrollX;
      let sy = scrollY;
      const t0 = performance.now();
      let still = t0;
      const tick = () => {
        const now = performance.now();
        const cur = els.map(pos);
        let change = scrollX !== sx || scrollY !== sy;
        for (let k = 0; k < cur.length && !change; k++) {
          const a = cur[k];
          const b = last[k];
          if ((a === null) !== (b === null) || (a && (Math.abs(a[0] - b[0]) > 0.5 || Math.abs(a[1] - b[1]) > 0.5))) change = true;
        }
        if (change) still = now;
        last = cur;
        sx = scrollX;
        sy = scrollY;
        if (now - still >= quiet) return resolve({ settled: true, ms: Math.round(now - t0) });
        if (now - t0 >= max) return resolve({ settled: false, ms: Math.round(now - t0) });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  // A tracking session: every frame, every tracked element's page position; a frame is recorded when an element
  // is more than 0.5 px from where it was last recorded (so a slow creep is caught too). Frames in which anything
  // scrolled are skipped, and the anchors rebased: scrolling is not an element moving.
  S.begin = (opts = {}) => {
    const els = candidates(opts.margin ?? 0);
    const s = {
      t0: performance.now(),
      items: els.map((el) => ({ el, base: pos(el), anchor: pos(el), own: ownText(el), frames: [] })).filter((it) => it.base),
      causes: [],
      hovers: [],
      excludes: (opts.exclude || []).map((i) => S.refs[i]).filter(Boolean),
      trigger: opts.trigger != null ? S.refs[opts.trigger] : null,
      lastScroll: S.scrolls.length,
      running: true,
      frames: 0,
    };
    S.session = s;
    const tick = () => {
      if (!s.running) return;
      const now = performance.now();
      s.frames++;
      const scrolled = S.scrolls.length !== s.lastScroll;
      s.lastScroll = S.scrolls.length;
      const hover = s.hovers.length ? s.hovers[s.hovers.length - 1] : null;
      // the element hovered just before: its hover-out transition may still be running
      const prevHover = s.hovers.length > 1 && now - s.t0 - hover.t < 800 ? s.hovers[s.hovers.length - 2] : null;
      for (const it of s.items) {
        const p = pos(it.el);
        if (!p) {
          it.gone = true;
          continue;
        }
        // A frame in which anything scrolled, or in which this element's own text changed (a status line going
        // from "Saving" to "Saved 21:38"), is not a move of this element: rebase and go on. What its new text
        // pushes aside is still caught on those other elements.
        const own = ownText(it.el);
        if (scrolled || own !== it.own) {
          it.anchor = p;
          it.own = own;
          continue;
        }
        const dx = p[0] - it.anchor[0];
        const dy = p[1] - it.anchor[1];
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          if (it.frames.length < 400) {
            let hovered = 0; // 0 no hover, 1 inside the hovered element and drawn through a transform, 2 the hovered element itself, 3 inside it by layout
            for (const h of [hover, prevHover]) {
              if (hovered || !h || !h.el || !(h.el === it.el || h.el.contains(it.el))) continue;
              hovered = h.el === it.el ? 2 : transformedBetween(it.el, h.el) ? 1 : h === hover ? 3 : 0;
            }
            it.frames.push([Math.round(now - s.t0), +dx.toFixed(1), +dy.toFixed(1), +(p[0] - it.base[0]).toFixed(1), +(p[1] - it.base[1]).toFixed(1), hover ? hover.i : -1, hovered, transformedBetween(it.el, null) ? 1 : 0]);
          }
          it.anchor = p;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { tracked: s.items.length };
  };
  S.cause = (what) => S.session && S.session.causes.push([Math.round(performance.now() - S.session.t0), what]);
  S.hover = (i) => {
    const s = S.session;
    if (s) s.hovers.push({ i, el: i == null ? null : S.refs[i], t: Math.round(performance.now() - s.t0) });
  };
  S.exclude = (i) => S.session && S.refs[i] && S.session.excludes.push(S.refs[i]);
  S.end = () => {
    const s = S.session;
    if (!s) return null;
    s.running = false;
    S.session = null;
    const tEnd = performance.now();
    const moving = s.items.filter((it) => it.frames.length);
    // Group elements that moved identically (a container and everything in it) and report the outermost one.
    const sig = (it) => it.frames.map((f) => `${f[0]}:${f[1]}:${f[2]}:${f[6]}`).join("|");
    const groups = new Map();
    for (const it of moving) {
      const k = sig(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const out = [];
    for (const list of groups.values()) {
      const roots = list.filter((it) => !list.some((o) => o !== it && o.el.contains(it.el)));
      const head = roots[0];
      const trig = s.trigger ? s.trigger.getBoundingClientRect() : null;
      out.push({
        ...S.describe(head.el),
        tag: head.el.tagName.toLowerCase(),
        also: list.length - 1,
        alsoText: roots.slice(1, 4).map((r) => label(r.el)).filter(Boolean),
        frames: head.frames,
        excluded: s.excludes.some((x) => x === head.el || x.contains(head.el)),
        belowTrigger: trig ? head.base[1] - scrollY >= trig.bottom - 2 : null,
        gone: Boolean(head.gone),
      });
    }
    const shifts = S.shifts.filter((e) => e.t >= s.t0 && e.t <= tEnd).map((e) => ({ ...e, t: Math.round(e.t - s.t0) }));
    return { tracked: s.items.length, frames: s.frames, ms: Math.round(tEnd - s.t0), causes: s.causes, hovers: s.hovers.map((h) => ({ i: h.i, t: h.t })), moved: out, shifts };
  };

  // Targets for each step.
  function unique(list, max, perKind) {
    const seen = new Map();
    const out = [];
    for (const el of list) {
      const kind = el.tagName + "|" + el.className;
      const n = seen.get(kind) || 0;
      if (n >= perKind) continue;
      seen.set(kind, n + 1);
      out.push(el);
      if (out.length >= max) break;
    }
    return out;
  }
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[inert],[aria-hidden=true],[data-stability-ignore]");
  };
  S.targets = (kind, max) => {
    let list = [];
    if (kind === "hover") {
      list = unique(
        [...document.querySelectorAll("a[href], button, [role=button], [role=tab], summary, tr, li, [data-flip], label")].filter(
          (el) => shown(el) && !el.disabled,
        ),
        max,
        3,
      );
    } else if (kind === "menus") {
      list = unique(
        [...document.querySelectorAll("button[aria-haspopup]:not([aria-haspopup=false]), button[aria-expanded], [role=combobox], summary")].filter(
          (el) => shown(el) && !el.disabled && el.getAttribute("aria-expanded") !== "true",
        ),
        max,
        2,
      );
    } else if (kind === "typing") {
      list = unique(
        [
          ...document.querySelectorAll(
            "input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], textarea, [contenteditable=true]",
          ),
        ].filter((el) => shown(el) && !el.disabled && !el.readOnly),
        max,
        2,
      );
    }
    return list.map((el) => {
      const d = S.describe(el);
      const filter =
        kind === "typing" &&
        (el.type === "search" || el.getAttribute("role") === "searchbox" || /search|filter|find/i.test(`${el.name} ${el.getAttribute("placeholder")} ${el.getAttribute("aria-label")}`));
      return { i: S.ref(el), sel: d.sel, text: d.text, type: el.type || el.tagName.toLowerCase(), value: "value" in el ? el.value : el.textContent, filter };
    });
  };
  S.overlays = () =>
    [...document.querySelectorAll("[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[data-sonner-toaster]")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  S.markOverlays = (before) => {
    const now = S.overlays();
    const fresh = now.filter((el) => !before.includes(el));
    for (const el of now) S.exclude(S.ref(el));
    return fresh.length;
  };
  S.liveSeconds = () => {
    const el = document.querySelector('[title^="Refreshes every"]');
    const m = el && /every (\d+)/.exec(el.getAttribute("title"));
    return m ? Number(m[1]) : 0;
  };
  S.links = () =>
    [...document.querySelectorAll("a[href]")]
      .filter((a) => !a.hasAttribute("download") && a.origin === location.origin)
      .map((a) => a.href.split("#")[0]);
  S.scoreConsole = () => {
    const groups = [...document.querySelectorAll('[role=group][aria-labelledby^="crit-"]')];
    const fb = document.querySelector("textarea#feedback");
    if (!groups.length || !fb || fb.readOnly) return null;
    const levels = groups.map((g) => [...g.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent.trim().replace(/\D.*/, "")));
    if (levels.some((l) => !l.length || l.some((x) => x === ""))) return null;
    if (groups.some((g) => g.querySelector("button[aria-pressed]").disabled)) return null;
    return { criteria: groups.length, min: levels.map((l) => l[0]), max: levels.map((l) => l[l.length - 1]), feedback: S.ref(fb), value: fb.value };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A minimal DevTools client.
// ---------------------------------------------------------------------------------------------------------------
function findChrome(explicit) {
  const tries = [explicit, process.env.CHROME_PATH];
  const pw = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "ms-playwright") : path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  try {
    const dirs = fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      tries.push(path.join(pw, d, "chrome-win64", "chrome.exe"), path.join(pw, d, "chrome-linux", "chrome"), path.join(pw, d, "chrome-linux64", "chrome"));
      tries.push(path.join(pw, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"));
      tries.push(path.join(pw, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
    }
  } catch {
    /* no Playwright browsers */
  }
  tries.push(
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  );
  return tries.find((p) => p && fs.existsSync(p));
}

async function launch(chromePath, headed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stability-chrome-"));
  const flags = [
    ...(headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb",
    "about:blank",
  ];
  const proc = spawn(chromePath, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start within 20 s")), 20000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}) before it listened`)));
  });
  const cdp = await connect(wsUrl);
  cdp.close = () => {
    try {
      cdp.ws.close();
    } catch {
      /* already closed */
    }
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      else proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    for (let k = 0; k < 10; k++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        execFileSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]);
      }
    }
  };
  return cdp;
}

async function connect(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) if (l.method === msg.method && (!l.session || l.session === msg.sessionId)) l.fn(msg.params);
    }
  };
  await new Promise((ok, bad) => ((ws.onopen = ok), (ws.onerror = () => bad(new Error("DevTools connection failed")))));
  return {
    ws,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    on: (method, session, fn) => listeners.push({ method, session, fn }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(cdp, { width, cookie, base, dark }) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Network.enable");
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `(${instrument.toString()})();` });
  await s("Emulation.setDeviceMetricsOverride", { width, height: SIZES[width] ?? 900, deviceScaleFactor: 1, mobile: width < 768 });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  if (cookie) await s("Network.setCookie", { name: "session", value: cookie, url: base, path: "/" });
  let loaded = 0;
  cdp.on("Page.loadEventFired", sessionId, () => loaded++);
  cdp.on("Page.javascriptDialogOpening", sessionId, () => s("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));
  const evaluate = async (expr) => {
    const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const mouse = (type, x, y, extra = {}) => s("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const KEYS = { Escape: 27, Backspace: 8, Enter: 13, Tab: 9, ArrowUp: 38, ArrowDown: 40 };
  const tab = {
    width,
    evaluate,
    async goto(url) {
      const before = loaded;
      const r = await s("Page.navigate", { url });
      if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
      for (let k = 0; k < 200 && loaded === before; k++) await sleep(100);
      await evaluate("document.fonts.ready.then(() => true)");
      return evaluate("({ url: location.href, status: performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0 })");
    },
    move: (x, y) => mouse("mouseMoved", x, y),
    async click(x, y) {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
    },
    async key(k, modifiers = 0) {
      if (KEYS[k]) {
        await s("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: KEYS[k], modifiers });
        await s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: KEYS[k], modifiers });
      } else if (modifiers) {
        const code = `Key${k.toUpperCase()}`;
        await s("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers, commands: k === "a" ? ["selectAll"] : [] });
        await s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers });
      } else {
        await s("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, unmodifiedText: k });
        await s("Input.dispatchKeyEvent", { type: "keyUp", key: k });
      }
    },
    async type(text, gap = [90, 160], pauseAt = -1) {
      for (let k = 0; k < text.length; k++) {
        await tab.key(text[k]);
        await sleep(gap[0] + Math.random() * (gap[1] - gap[0]));
        if (k === pauseAt) await sleep(600);
      }
    },
    insert: (text) => s("Input.insertText", { text }),
    close: () => cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {}),
  };
  return tab;
}

// ---------------------------------------------------------------------------------------------------------------
// Judging what moved.
// ---------------------------------------------------------------------------------------------------------------
function lastCauseBefore(causes, t) {
  let c = -Infinity;
  for (const [ct] of causes) if (ct <= t) c = ct;
  return c;
}
function classify(frames, origin = [0, 0]) {
  let bursts = 0;
  let prevT = -Infinity;
  let reversals = 0;
  let sx = 0;
  let sy = 0;
  let maxDisp = 0;
  for (const [t, dx, dy, bx, by] of frames) {
    if (t - prevT > 120) bursts++;
    prevT = t;
    const nx = Math.sign(Math.abs(dx) >= TURN ? dx : 0);
    const ny = Math.sign(Math.abs(dy) >= TURN ? dy : 0);
    if ((nx && sx && nx !== sx) || (ny && sy && ny !== sy)) reversals++;
    if (nx) sx = nx;
    if (ny) sy = ny;
    maxDisp = Math.max(maxDisp, Math.hypot(bx - origin[0], by - origin[1]));
  }
  return { bursts, reversals, maxDisp: Math.round(maxDisp * 10) / 10, span: frames.length ? frames[frames.length - 1][0] - frames[0][0] : 0, kind: bursts >= 2 || reversals >= 1 ? "jitter" : "shift" };
}

// rule: "neutral" (nothing may move, apart from GRACE after a cause), "overlay" (nothing outside the overlay may move,
// at any time), "disclosure" (within GRACE only what is below the trigger may move, and only down or up)
function judge(result, rule, ctx) {
  const findings = [];
  const infos = [];
  if (!result) return { findings, infos };
  for (const m of result.moved) {
    if (m.excluded) continue;
    let frames = m.frames;
    if (ctx.phase === "hover") {
      const own = frames.filter((f) => f[6] === 1 || f[6] === 2);
      if (own.length) infos.push({ ...ctx, sel: m.sel, text: m.text, note: "hover effect on the hovered element itself", ...classify(own) });
      frames = frames.filter((f) => f[6] !== 1 && f[6] !== 2);
    }
    let origin = [0, 0];
    let reason =
      rule === "overlay"
        ? "moved outside the menu or dialog that opened or closed"
        : rule === "disclosure"
          ? "moved sideways, or above the disclosure, when it opened or closed (it may only push down what is below it)"
          : "moved with no click or key that could move it";
    if (rule === "neutral") {
      // Cut at the first frame no cause explains: motion that starts, or turns back, more than CAUSE_LAG ms after the
      // last click or key that may move things (typing, hovering and waiting may not), or motion still going GRACE
      // ms after it. So a slide a score started may run on while the judge types, but not restart or turn back.
      let cut = -1;
      let prevT = -Infinity;
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < frames.length; k++) {
        const [t, dx, dy] = frames[k];
        const cause = lastCauseBefore(result.causes, t);
        const nx = Math.sign(Math.abs(dx) >= TURN ? dx : 0);
        const ny = Math.sign(Math.abs(dy) >= TURN ? dy : 0);
        const turn = (nx && sx && nx !== sx) || (ny && sy && ny !== sy);
        if ((t - prevT > 120 || turn) && t - cause > CAUSE_LAG) {
          cut = k;
          if (cause > -Infinity) reason = `${turn ? "turned back" : "started moving"} ${t - cause} ms after the last click or key that could move it`;
          break;
        }
        if (t > cause + GRACE) {
          cut = k;
          reason = `still moving ${t - cause} ms after the last click or key that could move it`;
          break;
        }
        prevT = t;
        if (nx) sx = nx;
        if (ny) sy = ny;
      }
      if (cut < 0) continue;
      if (cut > 0) origin = [frames[cut - 1][3], frames[cut - 1][4]];
      frames = frames.slice(cut);
    }
    if (rule === "disclosure") {
      frames = frames.filter((f) => {
        const inGrace = f[0] <= lastCauseBefore(result.causes, f[0]) + GRACE;
        return !(inGrace && m.belowTrigger && Math.abs(f[3]) < 1);
      });
    }
    if (!frames.length) continue;
    const c = classify(frames, origin);
    if (c.maxDisp < MIN_MOVE) continue;
    const hoveredIdx = [...new Set(frames.map((f) => f[5]).filter((i) => i >= 0))];
    const entry = {
      ...ctx,
      sel: m.sel,
      text: m.text,
      also: m.also,
      alsoText: m.alsoText,
      ...c,
      reason,
      frames: frames.length,
      first: frames[0][0],
      last: frames[frames.length - 1][0],
      net: [frames[frames.length - 1][3], frames[frames.length - 1][4]],
      viaTransform: frames.some((f) => f[7]),
      during: hoveredIdx.length && ctx.hoverNames ? hoveredIdx.map((i) => ctx.hoverNames[i]).filter(Boolean).slice(0, 3) : undefined,
    };
    delete entry.hoverNames;
    if (ctx.filter) infos.push({ ...entry, note: "typing into a search or filter box re-flows its results" });
    else findings.push(entry);
  }
  return { findings, infos };
}

function loadShiftFindings(shifts, ctx) {
  const out = [];
  for (const e of shifts) {
    if (e.value < 0.0005) continue;
    for (const src of e.sources) {
      // a rectangle with no area: the element came into or left the viewport; that is not a distance
      if (!src.prev || !src.cur || !src.prev.w || !src.prev.h || !src.cur.w || !src.cur.h) continue;
      // The browser clips both rectangles to the viewport, so a tall element pushed down shows a top that moved and a
      // bottom that did not (or the other way round): measure by the edge that is inside the viewport both times.
      const edge = (a0, a1, b0, b1) => (a0 > 0 && b0 > 0 ? b0 - a0 : b1 - a1);
      const dx = edge(src.prev.x, src.prev.x + src.prev.w, src.cur.x, src.cur.x + src.cur.w);
      const dy = edge(src.prev.y, src.prev.y + src.prev.h, src.cur.y, src.cur.y + src.cur.h);
      const d = Math.round(Math.hypot(dx, dy));
      if (d < MIN_MOVE) continue;
      out.push({ ...ctx, sel: src.sel, text: src.text, kind: "shift", reason: "moved after the page had drawn", maxDisp: d, bursts: 1, frames: 1, first: Math.round(e.t), last: Math.round(e.t), value: +e.value.toFixed(4), net: [dx, dy] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One page, every step.
// ---------------------------------------------------------------------------------------------------------------
const TYPE_TEXT = { email: "night.check@example.test", url: "https://example.test/x", tel: "+372 5555 1234", number: "42" };

async function testPage(tab, url, meta, opts, log) {
  const findings = [];
  const infos = [];
  const add = (r) => {
    findings.push(...r.findings);
    infos.push(...r.infos);
  };
  const ctxBase = { page: meta.path, template: meta.template, role: meta.role, width: tab.width };
  const nav = await tab.goto(url);
  const st = await tab.evaluate("__stab.settle(700, 8000)");
  const has = (p) => opts.phases.includes(p);
  if (has("load")) {
    const shifts = await tab.evaluate("__stab.shifts");
    findings.push(...loadShiftFindings(shifts, { ...ctxBase, phase: "load", action: `page load${st.settled ? "" : " (never settled in 8 s)"}` }));
  }
  const reset = async () => {
    await tab.move(2, 2);
    await tab.evaluate("scrollTo({ top: 0, left: 0, behavior: 'instant' }), __stab.settle(400, 4000)");
  };
  const back = async () => {
    const here = await tab.evaluate("location.href");
    // a changed query (the console keeps ?project= in the address) is the same page; another path is not
    if (new URL(here).pathname !== new URL(nav.url).pathname) {
      await tab.goto(nav.url);
      await tab.evaluate("__stab.settle(500, 6000)");
      return true;
    }
    return false;
  };

  if (has("idle")) {
    await reset();
    const live = await tab.evaluate("__stab.liveSeconds()");
    const wait = live ? live * 1000 + 3000 : 2500;
    await tab.evaluate("__stab.begin({ margin: 0 })");
    await sleep(wait);
    const r = await tab.evaluate("__stab.end()");
    add(judge(r, "neutral", { ...ctxBase, phase: live ? "refresh" : "idle", action: live ? `idle through a ${live} s live refresh` : "idle, no input" }));
    log(`    idle ${wait} ms: tracked ${r.tracked}, moved ${r.moved.length}`);
  }

  if (has("hover")) {
    await reset();
    const targets = await tab.evaluate(`__stab.targets("hover", ${opts.quick ? 10 : 18})`);
    let session = null;
    const flush = async () => {
      if (!session) return;
      await tab.move(2, 2);
      await tab.evaluate("__stab.hover(null)");
      await sleep(350);
      const r = await tab.evaluate("__stab.end()");
      add(judge(r, "neutral", { ...ctxBase, phase: "hover", action: "hovering", hoverNames: session.names }));
      session = null;
    };
    for (const t of targets) {
      let c = await tab.evaluate(`__stab.center(${t.i})`);
      if (!c) continue;
      if (!c.inView) {
        await flush();
        await tab.evaluate(`__stab.scrollTo(${t.i})`);
        await tab.evaluate("__stab.settle(300, 3000)");
        c = await tab.evaluate(`__stab.center(${t.i})`);
        if (!c || !c.inView) continue;
      }
      if (!c.reachable) continue;
      if (!session) {
        await tab.evaluate("__stab.begin({ margin: 0 })");
        session = { names: {} };
      }
      session.names[t.i] = `${t.sel} "${t.text.slice(0, 30)}"`;
      await tab.evaluate(`__stab.hover(${t.i})`);
      await tab.move(c.x, c.y);
      await sleep(300);
    }
    await flush();
    log(`    hover: ${targets.length} targets`);
  }

  if (has("menus")) {
    await reset();
    const triggers = await tab.evaluate(`__stab.targets("menus", ${opts.quick ? 3 : 6})`);
    for (const t of triggers) {
      await tab.evaluate(`__stab.scrollTo(${t.i}), __stab.settle(300, 3000)`);
      const c = await tab.evaluate(`__stab.center(${t.i})`);
      if (!c || !c.inView || !c.reachable) continue;
      await tab.evaluate("void (window.__before = __stab.overlays())");
      await tab.evaluate(`__stab.begin({ margin: 0, exclude: [${t.i}], trigger: ${t.i} })`);
      await tab.evaluate(`__stab.cause("click")`);
      await tab.click(c.x, c.y);
      await sleep(250);
      if (await back()) {
        log(`    menus: ${t.sel} navigated; back`);
        continue;
      }
      const overlay = await tab.evaluate("__stab.markOverlays(window.__before)");
      await sleep(900);
      const r = await tab.evaluate("__stab.end()");
      const name = `${t.sel} "${t.text.slice(0, 40)}"`;
      add(judge(r, overlay ? "overlay" : "disclosure", { ...ctxBase, phase: "menus", action: `opening ${overlay ? "the overlay of" : "the disclosure"} ${name}` }));
      await tab.evaluate(`window.__before = []; __stab.begin({ margin: 0, exclude: [${t.i}], trigger: ${t.i} }); __stab.markOverlays([])`);
      await tab.evaluate(`__stab.cause("close")`);
      if (overlay) await tab.key("Escape");
      else {
        const c2 = await tab.evaluate(`__stab.center(${t.i})`);
        if (c2 && c2.inView) await tab.click(c2.x, c2.y);
      }
      await sleep(900);
      const r2 = await tab.evaluate("__stab.end()");
      add(judge(r2, overlay ? "overlay" : "disclosure", { ...ctxBase, phase: "menus", action: `closing ${name}` }));
      await back();
      await tab.evaluate("__stab.settle(300, 3000)");
    }
    log(`    menus: ${triggers.length} triggers`);
  }

  if (has("typing")) {
    await reset();
    const fields = await tab.evaluate(`__stab.targets("typing", ${opts.quick ? 2 : 4})`);
    for (const f of fields) {
      await tab.evaluate(`__stab.scrollTo(${f.i}), __stab.settle(300, 3000)`);
      const c = await tab.evaluate(`__stab.center(${f.i})`);
      if (!c || !c.inView || !c.reachable) continue;
      await tab.click(c.x, c.y);
      await tab.evaluate("__stab.settle(300, 2000)");
      await tab.evaluate(`__stab.begin({ margin: 0, exclude: [${f.i}] })`);
      const text = TYPE_TEXT[f.type] ?? "quick note ok";
      await tab.type(text, [90, 160], Math.floor(text.length / 2));
      await sleep(900);
      const r = await tab.evaluate("__stab.end()");
      add(judge(r, "neutral", { ...ctxBase, phase: "typing", action: `typing into ${f.sel} "${f.text.slice(0, 40)}"`, filter: f.filter }));
      // put the old value back
      await tab.key("a", process.platform === "darwin" ? 4 : 2);
      await tab.key("Backspace");
      if (f.value) await tab.insert(f.value);
      await sleep(300);
      await back();
    }
    log(`    typing: ${fields.length} fields`);
  }

  if (has("scenario")) {
    await reset();
    const con = await tab.evaluate("__stab.scoreConsole()");
    if (con) {
      for (const pass of ["max", "min", "max"]) {
        await tab.key("Escape");
        await tab.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
        for (let k = 0; k < con.criteria; k++) await tab.key("ArrowUp");
        await tab.evaluate("__stab.settle(400, 4000)");
        await tab.evaluate("__stab.begin({ margin: 3000 })");
        for (let k = 0; k < con.criteria; k++) {
          await tab.evaluate(`__stab.cause("score")`);
          await tab.key(con[pass][k]);
          await sleep(140);
        }
        await tab.key("c"); // not a cause: moving the focus to the feedback box may not move anything
        await sleep(120);
        await tab.evaluate(`__stab.exclude(${con.feedback})`);
        await tab.type("Solid demo, clear", [90, 140]);
        await sleep(900);
        const r = await tab.evaluate("__stab.end()");
        add(judge(r, "neutral", { ...ctxBase, phase: "scenario", action: `scoring every criterion ${pass} by keyboard, then typing feedback at once` }));
        log(`    scenario ${pass}: tracked ${r.tracked}, causes ${JSON.stringify(r.causes)}; moved: ${r.moved.map((m) => `${m.sel.slice(-40)} [${m.frames.length} frames ${m.frames[0]?.[0]}..${m.frames.at(-1)?.[0]} ms]`).join("; ")}`);
        await tab.key("a", process.platform === "darwin" ? 4 : 2);
        await tab.key("Backspace");
        if (con.value) await tab.insert(con.value);
        await sleep(400);
      }
      log("    scenario: judge console, score then type, 3 passes");
    }
  }
  return { findings, infos, status: nav.status, finalUrl: nav.url };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes, sessions, crawling.
// ---------------------------------------------------------------------------------------------------------------
function routeTemplates() {
  const app = path.join(ROOT, "src", "app");
  const out = [];
  const walk = (dir, segs) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(segs);
      if (e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("@")) walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name]);
    }
  };
  walk(app, []);
  return out
    .map((segs) => {
      const tpl = "/" + segs.join("/");
      const re = new RegExp("^/" + segs.map((s) => (/^\[\.\.\./.test(s) ? ".+" : /^\[.*\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "/?$");
      return { tpl: tpl === "/" ? "/" : tpl, re, dyn: segs.filter((s) => s.startsWith("[")).length };
    })
    .sort((a, b) => a.dyn - b.dyn);
}

function readSessions(values) {
  let text = "";
  if (values.container) text = execFileSync("docker", ["logs", values.container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  if (values.sessions) text += "\n" + fs.readFileSync(values.sessions, "utf8");
  const out = { seeds: [] };
  for (const m of text.matchAll(/(organizer|judge_a|judge_b|participant)\s*=?\s*"?Cookie: session=([A-Za-z0-9_-]+)/g)) out[m[1]] = m[2];
  // the demo's open vote link, printed at boot
  for (const m of text.matchAll(/https?:\/\/[^\s/]+(\/vote\/[A-Za-z0-9_-]+)/g)) if (!out.seeds.includes(m[1])) out.seeds.push(m[1]);
  return out;
}

const SKIP = /\/api\/|\/sign-out|\/logout|\.(csv|json|txt|zip|png|jpg|pdf)(\?|$)|\/\.well-known\/|\/embed\.js/i;

async function runCombo(cdp, combo, opts, templates, log) {
  const tab = await openTab(cdp, { width: combo.width, cookie: combo.cookie, base: opts.base, dark: opts.dark });
  const seen = new Map(); // template+query keys -> url
  const queue = ["/", ...(combo.role === "organizer" ? ["/organize"] : []), ...(combo.role === "visitor" ? ["/sign-up"] : []), ...opts.seeds].map(
    (p) => new URL(p, opts.base).href,
  );
  const pages = [];
  const findings = [];
  const infos = [];
  const keyOf = (u) => {
    const url = new URL(u);
    const t = templates.find((x) => x.re.test(url.pathname));
    const q = [...url.searchParams.keys()].sort().join(",");
    return { template: t ? t.tpl : url.pathname, key: `${t ? t.tpl : url.pathname}?${q}` };
  };
  const perTemplate = new Map();
  for (const u of queue) {
    const k = keyOf(u);
    seen.set(k.key, u);
  }
  const tested = new Set();
  while (queue.length && pages.length < opts.maxPages) {
    const u = queue.shift();
    if (tested.has(keyOf(u).key)) continue;
    tested.add(keyOf(u).key);
    const url = new URL(u);
    const { template } = keyOf(u);
    if (opts.only && !opts.only.test(url.pathname + url.search)) {
      // still crawl through it for links, without testing
      try {
        await tab.goto(u);
        const links = await tab.evaluate("__stab.links()");
        log(`  (crawl only) ${url.pathname}: ${links.length} links`);
        for (const l of links) enqueue(l);
      } catch (e) {
        log(`  (crawl only) ${url.pathname}: ${e.message}`);
      }
      continue;
    }
    log(`  ${combo.role} ${combo.width}: ${url.pathname}${url.search}`);
    let res;
    try {
      res = await testPage(tab, u, { path: url.pathname + url.search, template, role: combo.role }, opts, log);
    } catch (e) {
      pages.push({ url: u, error: String(e.message || e) });
      log(`    error: ${e.message}`);
      continue;
    }
    pages.push({ url: u, status: res.status, final: res.finalUrl });
    for (const f of res.findings) log(`    FOUND ${f.kind} (${f.phase}) ${f.sel.slice(-60)} "${(f.text || "").slice(0, 40)}" ${f.maxDisp} px`);
    tested.add(keyOf(res.finalUrl).key);
    findings.push(...res.findings);
    infos.push(...res.infos);
    try {
      if ((await tab.evaluate("location.href")) !== res.finalUrl) await tab.goto(res.finalUrl);
      for (const l of await tab.evaluate("__stab.links()")) enqueue(l);
    } catch {
      /* no links */
    }
  }
  function enqueue(l) {
    let url;
    try {
      url = new URL(l);
    } catch {
      return;
    }
    if (url.origin !== new URL(opts.base).origin || SKIP.test(url.pathname)) return;
    const k = keyOf(url.href);
    if (seen.has(k.key)) return;
    const n = perTemplate.get(k.template) || 0;
    if (n >= 3) return; // at most three query variants of one route
    perTemplate.set(k.template, n + 1);
    seen.set(k.key, url.href);
    queue.push(url.href);
  }
  await tab.close();
  return { pages, findings, infos };
}

// ---------------------------------------------------------------------------------------------------------------
// The self-test: a page with three planted bugs and one control. The instrument must find exactly the planted ones.
// ---------------------------------------------------------------------------------------------------------------
const SELF_TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
body{font:16px sans-serif;margin:24px} li{padding:6px;border:1px solid #ccc;margin:4px 0;list-style:none}
#hov:hover{border-left:24px solid red} textarea{display:block;width:300px;height:60px;margin:12px 0}
</style></head><body>
<h1 id="title">Self-test</h1>
<p><a href="#" id="hov">Hover me: my border grows and pushes my text</a> <span id="next-to-hover">and this word</span></p>
<ol id="list"><li>Row one</li><li>Row two</li><li>Row three</li></ol>
<textarea id="bad" aria-label="bad field"></textarea>
<textarea id="good" aria-label="good field"></textarea>
<p id="calm">A calm paragraph that must never be reported.</p>
<script>
// planted 1: every keystroke in #bad restarts a slide on the list rows (the judge console's old bug, in miniature)
document.getElementById("bad").addEventListener("input", () => {
  for (const li of document.querySelectorAll("#list li")) li.animate([{ transform: "translateY(12px)" }, { transform: "none" }], { duration: 320 });
});
// planted 2: content that arrives late with no room kept for it (the Live clock before b578724)
setTimeout(() => { const s = document.createElement("span"); s.textContent = "Live · 12:34:56 "; document.getElementById("title").prepend(s); }, 2600);
</script></body></html>`;

async function selfTest(opts, log) {
  const cdp = await launch(opts.chrome, opts.headed);
  try {
    const tab = await openTab(cdp, { width: 1440, base: "about:blank" });
    const url = "data:text/html;base64," + Buffer.from(SELF_TEST_PAGE).toString("base64");
    const res = await testPage(tab, url, { path: "(self-test)", template: "(self-test)", role: "visitor" }, { ...opts, phases: ["load", "idle", "hover", "typing"] }, log);
    const hit = (phase, re, sel) => res.findings.some((f) => f.phase === phase && re.test(f.action) && sel.test(`${f.sel} ${f.text}`));
    const checks = [
      ["typing into #bad shakes the list (planted jitter)", hit("typing", /bad/, /li|Row/)],
      ["late content shifts the heading (planted shift, idle)", res.findings.some((f) => (f.phase === "idle" || f.phase === "load") && /h1|Self-test|title/.test(`${f.sel} ${f.text}`))],
      ["hovering the link pushes the word next to it (planted hover shift)", res.findings.some((f) => f.phase === "hover" && /next-to-hover|and this word/.test(`${f.sel} ${f.text}`))],
      ["typing into #good moves nothing (control)", !res.findings.some((f) => f.phase === "typing" && /good/.test(f.action))],
      ["the calm paragraph is never reported (control)", !res.findings.some((f) => /calm/.test(`${f.sel} ${f.text}`))],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
    if (opts.verbose) printFindings(res.findings, res.infos);
    await tab.close();
    return checks.every(([, ok]) => ok) ? 0 : 1;
  } finally {
    cdp.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------------------------------------------
function printFindings(findings, infos) {
  // One entry per cause: the same page, step and action (a disclosure that reflows a table moves a hundred cells);
  // under it the elements that moved furthest, and where (role and width) it happened.
  const groups = new Map();
  for (const f of findings) {
    const k = `${f.template}|${f.phase}|${f.action.replace(/:nth-of-type\(\d+\)/g, "").replace(/"[^"]*"$/, "")}`;
    if (!groups.has(k)) groups.set(k, { f, where: new Set(), els: new Map(), max: 0, jitter: false });
    const g = groups.get(k);
    g.where.add(`${f.role} ${f.width}`);
    g.max = Math.max(g.max, f.maxDisp);
    g.jitter ||= f.kind === "jitter";
    const e = g.els.get(f.sel);
    if (!e || e.maxDisp < f.maxDisp) g.els.set(f.sel, f);
  }
  const sorted = [...groups.values()].sort((a, b) => (a.jitter === b.jitter ? b.max - a.max : a.jitter ? -1 : 1));
  for (const { f, where, els, jitter } of sorted) {
    console.log(`\n${jitter ? "JITTER" : "SHIFT"}  ${f.template}   (${[...where].join(", ")})`);
    console.log(`  while: ${f.phase}: ${f.action}`);
    if (f.reason) console.log(`  why: ${f.reason}`);
    const list = [...els.values()].sort((a, b) => b.maxDisp - a.maxDisp);
    for (const e of list.slice(0, 3)) {
      console.log(`  element: ${e.sel}${e.text ? `  "${e.text}"` : ""}${e.also ? `  (+${e.also} moving the same way${e.alsoText?.length ? `: ${e.alsoText.map((t) => `"${t.slice(0, 25)}"`).join(", ")}` : ""})` : ""}`);
      console.log(
        `    moved ${e.kind === "jitter" ? "back and forth" : "once"}: up to ${e.maxDisp} px, ${e.bursts} burst${e.bursts === 1 ? "" : "s"}, ${e.frames} moving frame${e.frames === 1 ? "" : "s"} from ${e.first} to ${e.last} ms, ended ${e.net.map((n) => Math.round(n)).join(",")} px from where it was${e.viaTransform ? ", drawn through a transform (an animation)" : ""}${e.value ? `, layout-shift score ${e.value}` : ""}${e.during ? `; hovering ${e.during.join("; ")}` : ""}`,
      );
    }
    if (list.length > 3) console.log(`  ... and ${list.length - 3} more elements (in the JSON)`);
  }
  if (infos.length) {
    const seen = new Set();
    const lines = [];
    for (const i of infos) {
      const k = `${i.template}|${i.sel}|${i.note}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`  info  ${i.template}  ${i.sel}${i.text ? ` "${i.text.slice(0, 40)}"` : ""}: ${i.note} (${i.maxDisp} px)`);
    }
    console.log(`\n${lines.length} intended motions, not counted:`);
    for (const l of lines.slice(0, 40)) console.log(l);
    if (lines.length > 40) console.log(`  ... ${lines.length - 40} more in the JSON`);
  }
  return groups.size;
}

function loadAllow(file) {
  if (!file || !fs.existsSync(file)) return [];
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const a of list) if (!a.why) throw new Error(`${file}: every accepted motion needs a "why"`);
  return list.map((a) => ({ page: new RegExp(a.page || ".*"), phase: a.phase, element: new RegExp(a.element || ".*"), why: a.why }));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      container: { type: "string" },
      sessions: { type: "string" },
      roles: { type: "string", default: "organizer,judge,participant,visitor" },
      widths: { type: "string", default: "1440,390" },
      only: { type: "string" },
      phases: { type: "string", default: "load,idle,hover,menus,typing,scenario" },
      "max-pages": { type: "string", default: "40" },
      jobs: { type: "string", default: "2" },
      json: { type: "string" },
      allow: { type: "string" },
      chrome: { type: "string" },
      dark: { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      quick: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      seed: { type: "string", multiple: true, default: [] },
    },
  });
  const chrome = findChrome(values.chrome);
  if (!chrome) throw new Error("no Chrome or Chromium found; pass --chrome <path> or set CHROME_PATH");
  const log = values.verbose ? (s) => console.log(s) : () => {};
  const opts = {
    base: (positionals[0] || "http://localhost:8080").replace(/\/$/, ""),
    chrome,
    headed: values.headed,
    dark: values.dark,
    quick: values.quick,
    verbose: values.verbose,
    phases: values.phases.split(","),
    only: values.only ? new RegExp(values.only) : null,
    maxPages: Number(values["max-pages"]),
  };
  if (values["self-test"]) return selfTest(opts, log);

  const sessions = readSessions(values);
  opts.seeds = [...sessions.seeds, ...values.seed];
  const roleCookie = { organizer: sessions.organizer, judge: sessions.judge_a, judge_b: sessions.judge_b, participant: sessions.participant, visitor: null };
  const roles = values.roles.split(",");
  for (const r of roles) if (r !== "visitor" && !roleCookie[r]) throw new Error(`no session for ${r}: pass --container <portal container> or --sessions <checker-sessions.toml>`);
  const widths = values.widths.split(",").map(Number);
  const combos = roles.flatMap((role) => widths.map((width) => ({ role, width, cookie: roleCookie[role] })));
  const templates = routeTemplates();
  const allow = loadAllow(values.allow ?? path.join(ROOT, "tools", "stability-allow.json"));

  const started = Date.now();
  const all = { pages: [], findings: [], infos: [] };
  const pool = async (list, phases, note = "") => {
    if (!list.length) return;
    const work = [...list];
    const jobs = Math.max(1, Math.min(Number(values.jobs) || 1, work.length));
    await Promise.all(
      Array.from({ length: jobs }, async () => {
        const cdp = await launch(chrome, values.headed);
        try {
          while (work.length) {
            const combo = work.shift();
            console.log(`checking as ${combo.role} at ${combo.width} px${note}`);
            const r = await runCombo(cdp, combo, { ...opts, phases }, templates, log);
            all.pages.push(...r.pages.map((p) => ({ ...p, role: combo.role, width: combo.width, phases: phases.join(",") })));
            all.findings.push(...r.findings);
            all.infos.push(...r.infos);
          }
        } finally {
          cdp.close();
        }
      }),
    );
  };
  // Three stages, so what one role writes never looks like a change to another role's page: the judges type
  // feedback (saved as they type) only after the organizer pages have waited through their live refresh, and the
  // scores the judge scenario changes come last of all.
  const judges = (c) => c.role === "judge" || c.role === "judge_b";
  const plain = opts.phases.filter((p) => p !== "scenario");
  if (plain.length) {
    await pool(combos.filter((c) => !judges(c)), plain);
    await pool(combos.filter(judges), plain);
  }
  if (opts.phases.includes("scenario")) await pool(combos.filter(judges), ["scenario"], " (scenario pass)");
  const accepted = [];
  const findings = all.findings.filter((f) => {
    const a = allow.find((x) => x.page.test(f.page) && (!x.phase || x.phase === f.phase) && x.element.test(`${f.sel} ${f.text}`));
    if (a) accepted.push({ ...f, why: a.why });
    return !a;
  });
  const n = printFindings(findings, all.infos);
  const errors = all.pages.filter((p) => p.error);
  console.log(
    `\n${all.pages.length} page views (${[...new Set(all.pages.map((p) => p.url))].length} URLs) in ${Math.round((Date.now() - started) / 1000)} s; ${n} distinct findings (${findings.length} sightings)${accepted.length ? `, ${accepted.length} accepted by the allow list` : ""}${errors.length ? `; ${errors.length} pages failed to load` : ""}`,
  );
  for (const e of errors) console.log(`  page error: ${e.role} ${e.width} ${e.url}: ${e.error}`);
  if (!all.pages.some((p) => !p.error)) {
    console.error("stability-check: no page was checked (a wrong --only, no reachable links, or the portal is down); that is not a pass");
    return 2;
  }
  if (values.json) fs.writeFileSync(values.json, JSON.stringify({ base: opts.base, pages: all.pages, findings, accepted, infos: all.infos }, null, 2));
  return findings.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`stability-check: ${e.stack || e}`);
    process.exit(2);
  },
);
