import {
  bigserial,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    check(
      'users_email_normalized',
      sql`${table.email} = lower(${table.email}) AND length(trim(${table.email})) BETWEEN 3 AND 254`,
    ),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    idHash: varchar('id_hash', { length: 64 }).primaryKey(),
    session: jsonb('session').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_sessions_expires_at_idx').on(table.expiresAt)],
);

export const links = pgTable(
  'links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shortCode: varchar('short_code', { length: 32 }).notNull(),
    destinationUrl: text('destination_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('links_short_code_unique').on(table.shortCode),
    index('links_created_at_idx').on(table.createdAt),
    index('links_expires_at_idx').on(table.expiresAt),
    index('links_owner_created_idx').on(table.ownerId, table.createdAt),
    check('links_short_code_format', sql`${table.shortCode} ~ '^[A-Za-z0-9_-]{3,32}$'`),
    check('links_destination_url_not_empty', sql`length(trim(${table.destinationUrl})) > 0`),
  ],
);

export const clickEvents = pgTable(
  'click_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('click_events_clicked_at_idx').on(table.clickedAt),
    index('click_events_link_clicked_at_idx').on(table.linkId, table.clickedAt),
  ],
);

export type LinkRecord = typeof links.$inferSelect;
export type NewLinkRecord = typeof links.$inferInsert;
export type ClickEventRecord = typeof clickEvents.$inferSelect;
export type UserRecord = typeof users.$inferSelect;
