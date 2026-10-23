CREATE TABLE `service_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`anchor` integer NOT NULL,
	`restricted_until` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`lease_id` text,
	`lease_owner` text,
	`lease_expires` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `service_admin_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_budgets` (
	`month` text PRIMARY KEY NOT NULL,
	`spent` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_periods` (
	`account_id` text NOT NULL,
	`start` integer NOT NULL,
	`audio_used` integer DEFAULT 0 NOT NULL,
	`audio_reserved` integer DEFAULT 0 NOT NULL,
	`input_used` integer DEFAULT 0 NOT NULL,
	`input_reserved` integer DEFAULT 0 NOT NULL,
	`output_used` integer DEFAULT 0 NOT NULL,
	`output_reserved` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `start`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `service_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`period` integer NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`audio_ms` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`reserved_cost` integer NOT NULL,
	`cost` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`measurement` text DEFAULT 'reserved' NOT NULL,
	`request_id` text,
	`model` text NOT NULL,
	`pricing_version` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `service_requests_account` ON `service_requests` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `service_requests_expiry` ON `service_requests` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `service_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`warning_cents` integer,
	`hard_cents` integer,
	`paused` integer DEFAULT 0 NOT NULL,
	`quota_enforced` integer DEFAULT 0 NOT NULL,
	`regular_minutes` integer DEFAULT 60 NOT NULL,
	`regular_input` integer DEFAULT 1000000 NOT NULL,
	`regular_output` integer DEFAULT 100000 NOT NULL,
	`premium_minutes` integer DEFAULT 240 NOT NULL,
	`premium_input` integer DEFAULT 4000000 NOT NULL,
	`premium_output` integer DEFAULT 400000 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
