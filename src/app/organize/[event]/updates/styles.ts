// The update form's field styles, shared by the page (a server component) and the edit form (a client one). A plain
// module: a constant exported from a "use client" file reaches a server component as a client reference, not a string.
const field = "w-full rounded-sm border border-edge bg-surface px-2.5 text-14";
export const TITLE_INPUT = `h-8 ${field}`;
export const BODY_INPUT = `${field} py-2 font-serif text-15 leading-6`;
