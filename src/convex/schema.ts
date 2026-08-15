import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // arena.ai session: the user's arena.ai cookie, stored so server-side
    // actions can call arena.ai APIs on the user's behalf.
    arenaSessions: defineTable({
      clientId: v.string(), // stable id generated in the user's browser
      cookie: v.string(), // arena.ai cookie (e.g. arena-auth-prod-v1.0=...)
      arenaUserId: v.optional(v.string()),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      raw: v.optional(v.string()),
      updatedAt: v.number(),
    }).index("by_clientId", ["clientId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
