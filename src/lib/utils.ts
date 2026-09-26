import { createCn } from "cn/config";

// Class merging that knows this project's type scale. Without it, a size class such
// as text-15 reads as a colour and silently replaces text-on-primary (seen on the
// judge console's primary button, 2026-09-26).
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["12", "13", "14", "15", "17", "20", "24", "38", "64"] }] } },
});
