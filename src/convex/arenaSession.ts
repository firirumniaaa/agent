import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

/** Hanya dipanggil dari server (HTTP action) — cookie tidak boleh bocor ke klien. */
export const getCookie = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const session = await ctx.db
      .query("arenaSessions")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .first();
    return session?.cookie ?? null;
  },
});

/** Simpan/perbarui sesi (dipanggil dari action login). */
export const upsert = internalMutation({
  args: {
    clientId: v.string(),
    cookie: v.string(),
    arenaUserId: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    raw: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("arenaSessions")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .first();
    if (session) {
      await ctx.db.patch(session._id, { ...args, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("arenaSessions", { ...args, updatedAt: Date.now() });
    }
  },
});

/** Info sesi aktif untuk browser (tanpa cookie). */
export const me = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const session = await ctx.db
      .query("arenaSessions")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .first();
    if (!session) return null;
    return {
      name: session.name ?? null,
      email: session.email ?? null,
      arenaUserId: session.arenaUserId ?? null,
      // Repo dibaca dari env (ARENA_REPO_ID/OWNER/NAME) — opsional, seperti di script.
      repoConfigured: Boolean(
        process.env.ARENA_REPO_ID &&
          process.env.ARENA_REPO_OWNER &&
          process.env.ARENA_REPO_NAME,
      ),
      repoOwner: process.env.ARENA_REPO_OWNER ?? "",
      repoName: process.env.ARENA_REPO_NAME ?? "",
    };
  },
});

export const logout = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const session = await ctx.db
      .query("arenaSessions")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .first();
    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});
