import { boolean, integer, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';

export const usersTable = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
});

// Sources table schema used by Netlify Functions
// Note: JSONB columns are typed loosely to avoid schema drift issues.
export const sources = pgTable('sources', {
  id: varchar({ length: 255 }).primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  base_url: text().notNull(),
  default_headers: jsonb().$type<Record<string, unknown>>(),
  default_query: jsonb().$type<Record<string, unknown>>(),
  rate_limit: jsonb().$type<Record<string, unknown>>(),
  cache_ttl_s: integer().notNull(),
  key_template: varchar({ length: 512 }).notNull(),
  supports_pool: boolean().notNull(),
});
