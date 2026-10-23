CREATE TABLE `membership_admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`username` text NOT NULL,
	`previous_tier` text NOT NULL,
	`previous_expires_at` integer,
	`tier` text NOT NULL,
	`expires_at` integer,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `membership_admin_audit_account` ON `membership_admin_audit` (`account_id`,`created_at`);