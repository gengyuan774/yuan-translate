import {sqliteTable,text,integer,index,uniqueIndex,primaryKey} from 'drizzle-orm/sqlite-core';
export const memberSessions=sqliteTable('member_sessions',{
 tokenHash:text('token_hash').primaryKey(),codeVersion:text('code_version').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[index('member_sessions_expiry').on(t.expiresAt)]);
export const usageBuckets=sqliteTable('usage_buckets',{
 id:text('id').primaryKey(),count:integer('count').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[index('usage_buckets_expiry').on(t.expiresAt)]);
export const accounts=sqliteTable('accounts',{
 id:text('id').primaryKey(),provider:text('provider').notNull(),subjectHash:text('subject_hash').notNull(),label:text('label').notNull(),phoneE164:text('phone_e164'),createdAt:integer('created_at').notNull()
},t=>[uniqueIndex('accounts_identity').on(t.provider,t.subjectHash)]);
export const accountSessions=sqliteTable('account_sessions',{
 tokenHash:text('token_hash').primaryKey(),accountId:text('account_id').notNull().references(()=>accounts.id),expiresAt:integer('expires_at').notNull()
},t=>[index('account_sessions_expiry').on(t.expiresAt)]);
export const accountClasses=sqliteTable('account_classes',{
 accountId:text('account_id').notNull().references(()=>accounts.id),id:text('id').notNull(),title:text('title').notNull(),createdAt:text('created_at').notNull(),status:text('status').notNull(),segmentCount:integer('segment_count').notNull(),demo:integer('demo').notNull(),objectKey:text('object_key').notNull(),revision:integer('revision').notNull()
},t=>[primaryKey({columns:[t.accountId,t.id]}),index('account_classes_history').on(t.accountId,t.createdAt)]);
export const accountMaterials=sqliteTable('account_materials',{
 accountId:text('account_id').notNull().references(()=>accounts.id),classId:text('class_id').notNull(),id:text('id').notNull(),objectKey:text('object_key').notNull()
},t=>[primaryKey({columns:[t.accountId,t.classId,t.id]})]);

export const accountMemberships=sqliteTable('account_memberships',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id),tier:text('tier',{enum:['none','regular','premium']}).notNull(),expiresAt:integer('expires_at'),updatedAt:integer('updated_at').notNull()
});
export const memberRedemptions=sqliteTable('member_redemptions',{
 accountId:text('account_id').notNull().references(()=>accounts.id),codeVersion:text('code_version').notNull(),redeemedAt:integer('redeemed_at').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[primaryKey({columns:[t.accountId,t.codeVersion]})]);
export const phoneChallenges=sqliteTable('phone_challenges',{
 id:text('id').primaryKey(),phoneE164:text('phone_e164').notNull(),verificationSid:text('verification_sid').notNull(),attempts:integer('attempts').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[index('phone_challenges_expiry').on(t.expiresAt)]);

export const accountPasswords=sqliteTable('account_passwords',{
 username:text('username').primaryKey(),accountId:text('account_id').notNull().references(()=>accounts.id),passwordHash:text('password_hash').notNull(),createdAt:integer('created_at').notNull()
},t=>[uniqueIndex('account_passwords_account').on(t.accountId)]);

export const membershipAdminAudit=sqliteTable('membership_admin_audit',{
 id:text('id').primaryKey(),accountId:text('account_id').notNull().references(()=>accounts.id),username:text('username').notNull(),
 previousTier:text('previous_tier').notNull(),previousExpiresAt:integer('previous_expires_at'),tier:text('tier').notNull(),expiresAt:integer('expires_at'),reason:text('reason').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('membership_admin_audit_account').on(t.accountId,t.createdAt)]);

export const accountSecurity=sqliteTable('account_security',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id),status:text('status').notNull(),version:integer('version').notNull(),updatedAt:integer('updated_at').notNull()
});
export const recoveryEmails=sqliteTable('recovery_emails',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id),email:text('email').notNull(),verifiedAt:integer('verified_at').notNull()
},t=>[uniqueIndex('recovery_emails_unique').on(t.email)]);
export const recoveryChallenges=sqliteTable('recovery_challenges',{
 id:text('id').primaryKey(),accountId:text('account_id'),purpose:text('purpose').notNull(),email:text('email').notNull(),codeHash:text('code_hash').notNull(),version:integer('version').notNull(),attempts:integer('attempts').notNull(),expiresAt:integer('expires_at').notNull()
});
export const securityAudit=sqliteTable('security_audit',{
 id:text('id').primaryKey(),subject:text('subject').notNull(),actor:text('actor').notNull(),action:text('action').notNull(),details:text('details').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('security_audit_subject').on(t.subject,t.createdAt)]);
export const deletionJobs=sqliteTable('deletion_jobs',{
 id:text('id').primaryKey(),accountId:text('account_id'),tokenHash:text('token_hash').notNull(),status:text('status').notNull(),createdAt:integer('created_at').notNull(),completedAt:integer('completed_at')
});

export const paymentAccounts=sqliteTable('payment_accounts',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id,{onDelete:'cascade'}),version:integer('version').notNull()
});
export const paymentOrders=sqliteTable('payment_orders',{
 id:text('id').primaryKey(),accountId:text('account_id').references(()=>accounts.id,{onDelete:'set null'}),requestId:text('request_id').notNull(),
 planId:text('plan_id').notNull(),tier:text('tier').notNull(),amount:integer('amount').notNull(),currency:text('currency').notNull(),durationMs:integer('duration_ms').notNull(),
 merchantId:text('merchant_id').notNull(),appId:text('app_id').notNull(),state:text('state').notNull(),codeUrl:text('code_url'),transactionId:text('transaction_id'),
 refundedAmount:integer('refunded_amount').notNull(),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),paidAt:integer('paid_at'),
 sequence:integer('sequence'),floorStart:integer('floor_start'),grantStart:integer('grant_start'),grantEnd:integer('grant_end'),reviewReason:text('review_reason'),
 revision:integer('revision').notNull(),mutationToken:text('mutation_token')
},t=>[uniqueIndex('payment_order_request').on(t.accountId,t.requestId),uniqueIndex('payment_transaction').on(t.transactionId),index('payment_order_account').on(t.accountId,t.createdAt)]);
export const paymentRefunds=sqliteTable('payment_refunds',{
 id:text('id').primaryKey(),orderId:text('order_id').notNull().references(()=>paymentOrders.id),requestId:text('request_id').notNull(),amount:integer('amount').notNull(),
 reason:text('reason').notNull(),state:text('state').notNull(),providerId:text('provider_id'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()
},t=>[uniqueIndex('payment_refund_request').on(t.orderId,t.requestId)]);
export const paymentEvents=sqliteTable('payment_events',{
 id:text('id').primaryKey(),orderId:text('order_id').notNull().references(()=>paymentOrders.id),kind:text('kind').notNull(),payloadHash:text('payload_hash').notNull(),createdAt:integer('created_at').notNull()
});
