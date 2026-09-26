import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { apiTokens } from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { API_TOKEN_PREFIX } from "../session";
import { newId, newSecret, nowIso, sha256 } from "../util";
import { parse } from "./parse";

// A person's API tokens: made and revoked only from a signed-in session (never with
// a token), each acting as its owner with the owner's permissions.

export const TokenInput = z.object({
  name: z.string().trim().min(1, "give it a name you will recognise").max(60),
  days: z.coerce.number().int().min(1).max(365).nullable().default(90),
});

export function createApiToken(actor: Actor | null, body: unknown): { id: string; token: string; name: string; expiresAt: string | null } {
  return mutate({
    actor,
    action: "account.tokens",
    load: () => ({ kind: "platform" }),
    run: (tx) => {
      const input = parse(TokenInput, body);
      const now = nowIso();
      const token = `${API_TOKEN_PREFIX}${newSecret(30)}`;
      const id = newId("tok", 12);
      const expiresAt = input.days === null ? null : new Date(Date.parse(now) + input.days * 86_400_000).toISOString();
      tx.insert(apiTokens).values({ id, userId: actor!.userId, name: input.name, tokenHash: sha256(token), hint: token.slice(0, 10), createdAt: now, expiresAt }).run();
      return {
        result: { id, token, name: input.name, expiresAt },
        audit: { action: "token.create", targetType: "api_token", targetId: id, after: { name: input.name, expiresAt } },
      };
    },
  });
}

export function revokeApiToken(actor: Actor | null, tokenId: string): { id: string } {
  return mutate({
    actor,
    action: "account.tokens",
    load: () => ({ kind: "platform" }),
    run: (tx) => {
      const row = tx.select().from(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, actor!.userId))).get();
      if (!row) throw new NotFoundError("Token"); // someone else's token is not found, not forbidden
      if (row.revokedAt) return { result: { id: row.id }, audit: null };
      tx.update(apiTokens).set({ revokedAt: nowIso() }).where(eq(apiTokens.id, row.id)).run();
      return { result: { id: row.id }, audit: { action: "token.revoke", targetType: "api_token", targetId: row.id, after: { name: row.name } } };
    },
  });
}

export type TokenView = { id: string; name: string; hint: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null };

/** The actor's own tokens, newest first; never the tokens themselves. */
export function listApiTokens(actor: Actor | null): TokenView[] {
  guardRead(actor, "account.tokens", { kind: "platform" });
  return getDb()
    .select({ id: apiTokens.id, name: apiTokens.name, hint: apiTokens.hint, createdAt: apiTokens.createdAt, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.userId, actor!.userId))
    .orderBy(desc(apiTokens.createdAt))
    .all();
}
