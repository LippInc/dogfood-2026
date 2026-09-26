import "server-only";

// The public face of the data access layer. Pages, route handlers and server
// actions import from here and nowhere else under src/server (the boundary test
// enforces it), so every read and write passes the same authorize() gate.

export { currentActor } from "../session";
export type { Actor } from "../authz";
export { HttpError, AuthzError, NotFoundError, ValidationError, ConflictError } from "../errors";
export { getGallery, listEvents, type Gallery, type GalleryProject, type PublicEvent } from "./events";
export { createProject, ProjectInput } from "./projects";
export { json, route } from "../http";
export { actorNav, type NavLink } from "./nav";
export {
  demoIdentities,
  healthCheck,
  homeFor,
  signInAsDemo,
  signInWithPassword,
  signOut,
  type DemoIdentity,
  type SignInResult,
} from "./auth";
