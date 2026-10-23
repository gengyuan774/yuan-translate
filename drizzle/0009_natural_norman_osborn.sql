CREATE TABLE `auth_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`network_hash` text NOT NULL,
	`identity_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_network` ON `auth_attempts` (`action`,`network_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_attempts_identity` ON `auth_attempts` (`action`,`identity_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_attempts_time` ON `auth_attempts` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `registration_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`network_hash` text NOT NULL,
	`username_hash` text NOT NULL,
	`browser_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE INDEX `registration_challenges_expiry` ON `registration_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `trial_claims` (
	`identity_hash` text PRIMARY KEY NOT NULL,
	`claim_token` text NOT NULL,
	`claimed_at` integer NOT NULL
);
