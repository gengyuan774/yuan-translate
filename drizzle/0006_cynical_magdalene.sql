CREATE TABLE `payment_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `payment_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`request_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`tier` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`merchant_id` text NOT NULL,
	`app_id` text NOT NULL,
	`state` text NOT NULL,
	`code_url` text,
	`transaction_id` text,
	`refunded_amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`sequence` integer,
	`floor_start` integer,
	`grant_start` integer,
	`grant_end` integer,
	`review_reason` text,
	`revision` integer NOT NULL,
	`mutation_token` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_order_request` ON `payment_orders` (`account_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_transaction` ON `payment_orders` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `payment_order_account` ON `payment_orders` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `payment_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`request_id` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`state` text NOT NULL,
	`provider_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `payment_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refund_request` ON `payment_refunds` (`order_id`,`request_id`);