CREATE TABLE `account_security` (
	`account_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `recovery_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`purpose` text NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`version` integer NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recovery_emails` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_emails_unique` ON `recovery_emails` (`email`);--> statement-breakpoint
CREATE TABLE `security_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`details` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_audit_subject` ON `security_audit` (`subject`,`created_at`);