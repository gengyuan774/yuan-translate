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
 accountId:text('account_id').primaryKey().references(()=>accounts.id),tier:text('tier',{enum:['none','regular','premium']}).notNull(),expiresAt:integer('expires_at'),updatedAt:integer('updated_at').notNull(),quotaAnchor:integer('quota_anchor')
});
export const accountTrials=sqliteTable('account_trials',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id),grantedAt:integer('granted_at').notNull()
});
export const planBalances=sqliteTable('plan_balances',{
 accountId:text('account_id').notNull().references(()=>accounts.id),scope:text('scope').notNull(),start:integer('start').notNull(),audioUsed:integer('audio_used').notNull().default(0),audioReserved:integer('audio_reserved').notNull().default(0),summariesUsed:integer('summaries_used').notNull().default(0),summariesReserved:integer('summaries_reserved').notNull().default(0)
},t=>[primaryKey({columns:[t.accountId,t.scope,t.start]})]);
export const serviceSummaryJobs=sqliteTable('service_summary_jobs',{
 id:text('id').primaryKey(),accountId:text('account_id').notNull().references(()=>accounts.id),balanceScope:text('balance_scope').notNull(),balanceStart:integer('balance_start').notNull(),inputHash:text('input_hash').notNull(),state:text('state').notNull(),result:text('result'),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[index('service_summary_cache').on(t.accountId,t.inputHash,t.state),index('service_summary_expiry').on(t.state,t.expiresAt)]);
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

export const serviceAccounts=sqliteTable('service_accounts',{
 accountId:text('account_id').primaryKey().references(()=>accounts.id),anchor:integer('anchor').notNull(),restrictedUntil:integer('restricted_until').notNull().default(0),reason:text('reason').notNull().default(''),leaseId:text('lease_id'),leaseOwner:text('lease_owner'),leaseExpires:integer('lease_expires').notNull().default(0)
});
export const servicePeriods=sqliteTable('service_periods',{
 accountId:text('account_id').notNull().references(()=>accounts.id),start:integer('start').notNull(),audioUsed:integer('audio_used').notNull().default(0),audioReserved:integer('audio_reserved').notNull().default(0),inputUsed:integer('input_used').notNull().default(0),inputReserved:integer('input_reserved').notNull().default(0),outputUsed:integer('output_used').notNull().default(0),outputReserved:integer('output_reserved').notNull().default(0)
},t=>[primaryKey({columns:[t.accountId,t.start]})]);
export const serviceSettings=sqliteTable('service_settings',{
 id:text('id').primaryKey(),warningCents:integer('warning_cents'),hardCents:integer('hard_cents'),paused:integer('paused').notNull().default(0),quotaEnforced:integer('quota_enforced').notNull().default(0),regularMinutes:integer('regular_minutes').notNull().default(60),regularInput:integer('regular_input').notNull().default(1000000),regularOutput:integer('regular_output').notNull().default(100000),premiumMinutes:integer('premium_minutes').notNull().default(240),premiumInput:integer('premium_input').notNull().default(4000000),premiumOutput:integer('premium_output').notNull().default(400000),revision:integer('revision').notNull().default(0),updatedAt:integer('updated_at').notNull()
});
export const serviceBudgets=sqliteTable('service_budgets',{
 month:text('month').primaryKey(),spent:integer('spent').notNull().default(0),reserved:integer('reserved').notNull().default(0)
});
export const serviceRequests=sqliteTable('service_requests',{
 id:text('id').primaryKey(),accountId:text('account_id').references(()=>accounts.id,{onDelete:'set null'}),period:integer('period').notNull(),month:text('month').notNull(),kind:text('kind').notNull(),state:text('state').notNull(),audioMs:integer('audio_ms').notNull(),inputTokens:integer('input_tokens').notNull(),outputTokens:integer('output_tokens').notNull(),reservedCost:integer('reserved_cost').notNull(),cost:integer('cost').notNull().default(0),expiresAt:integer('expires_at').notNull(),createdAt:integer('created_at').notNull(),measurement:text('measurement').notNull().default('reserved'),requestId:text('request_id'),model:text('model').notNull(),pricingVersion:text('pricing_version').notNull(),
 balanceScope:text('balance_scope'),balanceStart:integer('balance_start')
},t=>[index('service_requests_account').on(t.accountId,t.createdAt),index('service_requests_expiry').on(t.state,t.expiresAt)]);
export const serviceAlerts=sqliteTable('service_alerts',{
 id:text('id').primaryKey(),month:text('month').notNull(),kind:text('kind').notNull(),createdAt:integer('created_at').notNull(),details:text('details').notNull()
});
export const serviceAdminSessions=sqliteTable('service_admin_sessions',{
 hash:text('hash').primaryKey(),kind:text('kind').notNull(),expiresAt:integer('expires_at').notNull()
});

export const registrationChallenges=sqliteTable('registration_challenges',{
 id:text('id').primaryKey(),nonce:text('nonce').notNull(),networkHash:text('network_hash').notNull(),usernameHash:text('username_hash').notNull(),browserHash:text('browser_hash').notNull(),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),claimedAt:integer('claimed_at')
},t=>[index('registration_challenges_expiry').on(t.expiresAt)]);
export const authAttempts=sqliteTable('auth_attempts',{
 id:text('id').primaryKey(),action:text('action').notNull(),networkHash:text('network_hash').notNull(),identityHash:text('identity_hash').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('auth_attempts_network').on(t.action,t.networkHash,t.createdAt),index('auth_attempts_identity').on(t.action,t.identityHash,t.createdAt),index('auth_attempts_time').on(t.action,t.createdAt),index('auth_attempts_retention').on(t.createdAt)]);
export const trialClaims=sqliteTable('trial_claims',{
 identityHash:text('identity_hash').primaryKey(),claimToken:text('claim_token').notNull(),claimedAt:integer('claimed_at').notNull()
});
