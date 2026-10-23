CREATE TABLE `account_trials` (
	`account_id` text PRIMARY KEY NOT NULL,
	`granted_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plan_balances` (
	`account_id` text NOT NULL,
	`scope` text NOT NULL,
	`start` integer NOT NULL,
	`audio_used` integer DEFAULT 0 NOT NULL,
	`audio_reserved` integer DEFAULT 0 NOT NULL,
	`summaries_used` integer DEFAULT 0 NOT NULL,
	`summaries_reserved` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `scope`, `start`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `service_summary_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`balance_scope` text NOT NULL,
	`balance_start` integer NOT NULL,
	`input_hash` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_summary_cache` ON `service_summary_jobs` (`account_id`,`input_hash`,`state`);--> statement-breakpoint
CREATE INDEX `service_summary_expiry` ON `service_summary_jobs` (`state`,`expires_at`);--> statement-breakpoint
ALTER TABLE `account_memberships` ADD `quota_anchor` integer;--> statement-breakpoint
ALTER TABLE `service_requests` ADD `balance_scope` text;--> statement-breakpoint
ALTER TABLE `service_requests` ADD `balance_start` integer;