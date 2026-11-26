CREATE TABLE `terminal_actions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`terminal_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`grant_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`grant_version` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`workspace_id` varchar(64) NOT NULL,
	`tool` varchar(40) NOT NULL,
	`source_message_id` char(36) character set ascii collate ascii_general_ci,
	`source_content_version` int,
	`requested_by` varchar(16) NOT NULL,
	`arguments` json,
	`state` varchar(16) NOT NULL,
	`claim_id` char(36) character set ascii collate ascii_general_ci,
	`dispatched_connection_id` char(36) character set ascii collate ascii_general_ci,
	`receipt_hash` varchar(64),
	`result` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deadline_at` datetime(3) NOT NULL,
	CONSTRAINT `terminal_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `terminal_actions_request` UNIQUE(`owner_id`,`requested_by`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `terminal_grants` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`terminal_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`workspace_id` varchar(64) NOT NULL,
	`tool` varchar(40) NOT NULL,
	`version` int NOT NULL,
	`enabled` boolean NOT NULL,
	CONSTRAINT `terminal_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `terminal_grants_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `terminal_grants_scope` UNIQUE(`owner_id`,`terminal_id`,`conversation_id`,`companion_id`,`runtime_epoch`,`workspace_id`,`tool`)
);
--> statement-breakpoint
CREATE TABLE `terminals` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`name` varchar(80) NOT NULL,
	`secret_hash` varchar(64) NOT NULL,
	`connection_id` char(36) character set ascii collate ascii_general_ci,
	`workspace_id` varchar(64),
	`capabilities` json,
	`last_heartbeat_at` datetime(3),
	`expires_at` datetime(3),
	`revoked_at` datetime(3),
	CONSTRAINT `terminals_id` PRIMARY KEY(`id`),
	CONSTRAINT `terminals_owner_id` UNIQUE(`owner_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `terminal_actions` ADD CONSTRAINT `terminal_actions_terminal_ref` FOREIGN KEY (`owner_id`,`terminal_id`) REFERENCES `terminals`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `terminal_actions` ADD CONSTRAINT `terminal_actions_grant_ref` FOREIGN KEY (`owner_id`,`grant_id`) REFERENCES `terminal_grants`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `terminal_grants` ADD CONSTRAINT `terminal_grants_terminal_ref` FOREIGN KEY (`owner_id`,`terminal_id`) REFERENCES `terminals`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `terminals` ADD CONSTRAINT `terminals_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `terminal_actions_queue` ON `terminal_actions` (`owner_id`,`terminal_id`,`state`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `terminal_actions_source` ON `terminal_actions` (`owner_id`,`source_message_id`,`source_content_version`);--> statement-breakpoint
CREATE INDEX `terminal_actions_instance` ON `terminal_actions` (`owner_id`,`companion_id`,`runtime_epoch`);--> statement-breakpoint
CREATE INDEX `terminal_grants_lookup` ON `terminal_grants` (`owner_id`,`conversation_id`,`companion_id`,`runtime_epoch`,`enabled`);