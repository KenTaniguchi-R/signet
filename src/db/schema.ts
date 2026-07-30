import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Org-scoped RBAC role. Read from THIS table, never from the session —
 * nextjs-auth0 #2629 drops custom claims after a token refresh.
 */
export type Role = 'finance' | 'legal' | 'ops' | 'member';

export type LineItemStatus =
  | 'proposed'
  | 'auto_approved'
  | 'awaiting_approval'
  | 'approved'
  | 'declined'
  | 'charged';

export type ApprovalStatus = 'pending' | 'approved' | 'declined';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  auth0OrgId: text('auth0_org_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auth0Sub: text('auth0_sub').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<Role>().notNull().default('member'),
    /** Auth0 refresh token, encrypted at rest. Subject token for the RFC 8693 exchange. */
    encryptedRefreshToken: text('encrypted_refresh_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('users_sub_org_idx').on(t.auth0Sub, t.orgId)],
);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  title: text('title').notNull(),
  budgetCents: integer('budget_cents').notNull(),
  status: text('status').notNull().default('planning'),
  /** Serialized ModelMessage[] from the spend call. Needed to resume after approval. */
  messagesJson: jsonb('messages_json'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const lineItems = pgTable('line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id),
  category: text('category').notNull(),
  vendor: text('vendor').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reversible: boolean('reversible').notNull().default(true),
  status: text('status').$type<LineItemStatus>().notNull().default('proposed'),
  stripeCardholderId: text('stripe_cardholder_id'),
  stripeCardId: text('stripe_card_id'),
  stripeAuthorizationId: text('stripe_authorization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineItemId: uuid('line_item_id')
      .notNull()
      .references(() => lineItems.id),
    /** AI SDK v7 tool-approval id — the handle used to resume the run. */
    approvalId: text('approval_id').notNull(),
    /** Resolved by the policy router. NEVER supplied by the model or the client. */
    requiredRole: text('required_role').$type<Role>().notNull(),
    requiredApproverId: uuid('required_approver_id').references(() => users.id),
    ruleName: text('rule_name').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    /** Set from the SERVER SESSION on approve. Never from the request body. */
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('approvals_item_role_idx').on(t.lineItemId, t.requiredRole)],
);

export const activity = pgTable('activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  kind: text('kind').notNull(),
  /** What the model supplied. */
  payloadJson: jsonb('payload_json'),
  /** What the harness resolved and injected — the boundary, made auditable. */
  harnessInjectedJson: jsonb('harness_injected_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
