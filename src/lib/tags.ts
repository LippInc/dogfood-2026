/**
 * The tech-tag picker's list and its rules, shared by the picker (src/components/tag-picker.tsx) and its tests.
 *
 * The server keeps a tag as typed, trimmed, and compares tags without case ("Rust" and "rust" are one tag), at most
 * TAG_LIMIT of them, each at most TAG_MAX_LENGTH characters (MAX_TAGS and MAX_TAG_LENGTH in
 * src/server/project-limits.ts; tests/tag-picker.test.ts holds the two copies equal). The form sends the chips as one
 * value joined by ", " and the save action splits it on commas, so a tag can never hold a comma.
 */

/** How many tags a project carries at most: the server holds to the same (MAX_TAGS). */
export const TAG_LIMIT = 8;
/** The longest tag: the server holds to the same (MAX_TAG_LENGTH). */
export const TAG_MAX_LENGTH = 40;

/**
 * Common hackathon tech tags, sorted without case: languages, frameworks, databases, cloud, AI and ML, data, hardware,
 * games, AR and VR, blockchain, APIs and platforms, and the themes events set. Each in its project's own spelling.
 */
const TAGS = [
  ".NET",
  "3D printing",
  "Accessibility",
  "Agriculture",
  "AI",
  "AI agents",
  "Airtable",
  "Algolia",
  "Android",
  "Angular",
  "Ansible",
  "Apache Kafka",
  "Apache Spark",
  "API",
  "Apple Vision Pro",
  "AR",
  "ARCore",
  "Arduino",
  "ARKit",
  "Assembly",
  "Astro",
  "Audio",
  "Auth0",
  "Automation",
  "AWS",
  "AWS Lambda",
  "Azure",
  "Babylon.js",
  "Bash",
  "Bitcoin",
  "Blender",
  "Blockchain",
  "Bluetooth",
  "Bootstrap",
  "Bun",
  "C",
  "C#",
  "C++",
  "Chrome extension",
  "CI/CD",
  "Claude",
  "Climate",
  "CLI",
  "Clojure",
  "Cloudflare",
  "Cloudflare Workers",
  "CockroachDB",
  "Computer vision",
  "Convex",
  "Cryptography",
  "CSS",
  "CUDA",
  "Cybersecurity",
  "D3.js",
  "Dart",
  "Data science",
  "Data visualization",
  "Deno",
  "DevOps",
  "Diffusion models",
  "Discord",
  "Discord bot",
  "Django",
  "Docker",
  "Drizzle",
  "DuckDB",
  "DynamoDB",
  "E-commerce",
  "Edge computing",
  "Education",
  "Elasticsearch",
  "Electron",
  "Elixir",
  "Elm",
  "Embedded",
  "Emotion recognition",
  "Energy",
  "Erlang",
  "ESP32",
  "Ethereum",
  "Express",
  "F#",
  "FastAPI",
  "Figma",
  "Fintech",
  "Firebase",
  "Flask",
  "Flutter",
  "Fly.io",
  "Food",
  "FPGA",
  "Framer Motion",
  "Game",
  "Game jam",
  "Gemini",
  "Generative AI",
  "Git",
  "GitHub Actions",
  "GitHub API",
  "GLSL",
  "Go",
  "Godot",
  "Google Cloud",
  "Google Maps API",
  "GPT",
  "GPU",
  "Gradio",
  "GraphQL",
  "gRPC",
  "Hardware",
  "Haskell",
  "Health",
  "Heroku",
  "Hono",
  "HTML",
  "htmx",
  "Hugging Face",
  "human-computer-interaction",
  "Humanitarian",
  "Image processing",
  "IoT",
  "iOS",
  "Java",
  "JavaScript",
  "Jetpack Compose",
  "Jupyter",
  "Kotlin",
  "Kubernetes",
  "LangChain",
  "Laravel",
  "LiDAR",
  "Linux",
  "Llama",
  "LLM",
  "LlamaIndex",
  "Lua",
  "Machine learning",
  "Mapbox",
  "Maps",
  "MATLAB",
  "Matter",
  "Mental health",
  "Microcontroller",
  "Mistral",
  "Mixed reality",
  "MLOps",
  "Mobile",
  "MongoDB",
  "MQTT",
  "Music",
  "MySQL",
  "Neo4j",
  "Neon",
  "Nest.js",
  "Netlify",
  "Networking",
  "Next.js",
  "NFC",
  "NFT",
  "nginx",
  "Nim",
  "NLP",
  "Node.js",
  "Notion API",
  "Nuxt",
  "NumPy",
  "Nvidia Jetson",
  "OAuth",
  "OCaml",
  "Ollama",
  "Open data",
  "Open source",
  "OpenAI",
  "OpenCV",
  "OpenStreetMap",
  "Pandas",
  "Payments",
  "PHP",
  "Phaser",
  "Pinecone",
  "PlanetScale",
  "Playwright",
  "PostgreSQL",
  "PostHog",
  "Prisma",
  "Privacy",
  "Productivity",
  "Prometheus",
  "Prompt engineering",
  "PWA",
  "PyTorch",
  "Python",
  "Quantum computing",
  "Qiskit",
  "R",
  "RAG",
  "Raspberry Pi",
  "React",
  "React Native",
  "Redis",
  "Reinforcement learning",
  "Remix",
  "REST API",
  "RFID",
  "Robotics",
  "ROS",
  "Ruby",
  "Ruby on Rails",
  "Rust",
  "Sass",
  "Scala",
  "scikit-learn",
  "Security",
  "Sensors",
  "Serverless",
  "shadcn/ui",
  "Shopify",
  "Slack",
  "Smart contracts",
  "Smart home",
  "Social good",
  "Social media",
  "Solana",
  "Solid",
  "Solidity",
  "Speech recognition",
  "Spotify API",
  "Spring Boot",
  "SQL",
  "SQLite",
  "Stable Diffusion",
  "Streamlit",
  "Stripe",
  "Supabase",
  "Sustainability",
  "Svelte",
  "SvelteKit",
  "Swift",
  "SwiftUI",
  "Tailwind CSS",
  "Tauri",
  "Telegram bot",
  "TensorFlow",
  "Terraform",
  "Text to speech",
  "Three.js",
  "Transportation",
  "tRPC",
  "Turso",
  "Twilio",
  "TypeScript",
  "Unity",
  "Unreal Engine",
  "Upstash",
  "Vercel",
  "Vite",
  "Voice assistant",
  "VR",
  "Vue",
  "Wasm",
  "Wearables",
  "Web3",
  "WebAssembly",
  "WebGL",
  "WebGPU",
  "WebRTC",
  "WebSockets",
  "WhatsApp API",
  "Whisper",
  "Zig",
  "Zod",
];
export const TAG_LIST: readonly string[] = [...TAGS].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

export type TagOption = {
  /** the tag as it is added */
  label: string;
  /** "event": another project of this event carries it; "list": from TAG_LIST; "custom": what the person typed */
  source: "event" | "list" | "custom";
};

/** How the picker compares tags: without case and the space around, as the server does. */
export const tagKey = (tag: string) => tag.trim().toLowerCase();

/** A tag cleaned as the server keeps it: trimmed, inner runs of space made one, never a comma. */
export function cleanTag(typed: string): string {
  return typed.replace(/\s+/g, " ").trim();
}

/** Why a typed tag cannot be added, in words for the person, or null when it can. */
export function tagProblem(typed: string, picked: readonly string[]): string | null {
  const tag = cleanTag(typed);
  if (!tag) return null;
  if (picked.length >= TAG_LIMIT) return `${TAG_LIMIT} tags is the most: remove one first.`;
  if (tag.includes(",")) return "A tag cannot hold a comma.";
  if (tag.length > TAG_MAX_LENGTH) return `A tag is at most ${TAG_MAX_LENGTH} characters.`;
  if (picked.some((p) => tagKey(p) === tagKey(tag))) return `“${tag}” is picked already.`;
  return null;
}

/** The chips after adding a tag: unchanged when the tag is empty, a duplicate (without case), too long, holds a comma, or the limit is reached. */
export function addTag(picked: readonly string[], typed: string): string[] {
  const tag = cleanTag(typed);
  if (!tag || tagProblem(tag, picked)) return [...picked];
  return [...picked, tag];
}

/** The chips without one tag (compared without case). */
export function removeTag(picked: readonly string[], tag: string): string[] {
  return picked.filter((p) => tagKey(p) !== tagKey(tag));
}

/** Where a typed text matches a tag: 0 at the start, 1 at the start of a later word, 2 anywhere else, -1 not at all. */
function matchRank(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 0;
  const at = l.indexOf(q);
  if (at < 0) return -1;
  return /[\s\-./]/.test(l[at - 1] ?? "") ? 1 : 2;
}

/**
 * The suggestions for what is typed: the tags other projects of the event carry first (as they carry them, the most
 * carried first), then the list; a tag already picked is left out, and so is one the event's projects already spell.
 * With text typed, the tags that start with it come before those that only contain it; when nothing matches it
 * exactly, the typed tag itself is offered last ("custom"), if the server would take it.
 */
export function suggestTags(typed: string, picked: readonly string[], eventTags: readonly string[], limit = Infinity): TagOption[] {
  const q = cleanTag(typed).toLowerCase();
  const taken = new Set(picked.map(tagKey));
  const seen = new Set<string>();
  const pool: TagOption[] = [];
  for (const [list, source] of [
    [eventTags, "event"],
    [TAG_LIST, "list"],
  ] as const) {
    for (const raw of list) {
      const label = cleanTag(raw);
      const key = tagKey(label);
      if (!label || seen.has(key) || taken.has(key)) continue;
      seen.add(key);
      pool.push({ label, source });
    }
  }
  let out: TagOption[];
  if (!q) {
    out = pool;
  } else {
    out = pool
      .map((o, i) => ({ o, i, r: matchRank(o.label, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.o);
  }
  out = out.slice(0, limit);
  const exact = seen.has(q) || taken.has(q);
  if (q && !exact && !tagProblem(typed, picked)) out.push({ label: cleanTag(typed), source: "custom" });
  return out;
}

/** The one value the form sends, as the save action has always parsed it: the chips joined by ", ". */
export const joinTags = (picked: readonly string[]) => picked.join(", ");

/** The chips a saved value draws, as the save action parses it: split on commas, trimmed, the empty ones dropped. */
export const splitTags = (value: string) =>
  value
    .split(/,/)
    .map((s) => s.trim())
    .filter(Boolean);
