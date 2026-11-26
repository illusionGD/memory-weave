CREATE TABLE `autonomy_opportunities` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`policy_version` int NOT NULL,
	`mode` varchar(10) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`reason` varchar(64),
	`explanation` varchar(400),
	`preparation` json,
	`source_message_id` char(36) character set ascii collate ascii_general_ci,
	`activity_id` char(36) character set ascii collate ascii_general_ci,
	`contact_id` char(36) character set ascii collate ascii_general_ci,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `autonomy_opportunities_id` PRIMARY KEY(`id`),
	CONSTRAINT `autonomy_opportunity_owner_id` UNIQUE(`owner_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `autonomy_policies` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`enabled` boolean NOT NULL,
	`contacts_enabled` boolean NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `autonomy_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `autonomy_policy_version` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`version`),
	CONSTRAINT `autonomy_policy_request` UNIQUE(`owner_id`,`companion_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `autonomy_usage` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci,
	`kind` varchar(16) NOT NULL,
	`event_key` varchar(85) NOT NULL,
	`time_zone` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `autonomy_usage_id` PRIMARY KEY(`id`),
	CONSTRAINT `autonomy_usage_event` UNIQUE(`owner_id`,`kind`,`event_key`)
);
--> statement-breakpoint
CREATE TABLE `contact_intents` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`opportunity_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`policy_version` int NOT NULL,
	`state` varchar(16) NOT NULL,
	`reason` varchar(64),
	`explanation` varchar(400),
	`text` text,
	`source_message_id` char(36) character set ascii collate ascii_general_ci,
	`source_content_version` int,
	`message_id` char(36) character set ascii collate ascii_general_ci,
	`expires_at` datetime(3) NOT NULL,
	`published_at` datetime(3),
	`acknowledged_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `contact_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `contact_opportunity` UNIQUE(`owner_id`,`opportunity_id`)
);
--> statement-breakpoint
ALTER TABLE `activities` ADD `origin` varchar(16) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `autonomy_opportunities` ADD CONSTRAINT `autonomy_opportunity_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `autonomy_usage` ADD CONSTRAINT `autonomy_usage_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contact_intents` ADD CONSTRAINT `contact_opportunity_ref` FOREIGN KEY (`owner_id`,`opportunity_id`) REFERENCES `autonomy_opportunities`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `autonomy_opportunity_view` ON `autonomy_opportunities` (`owner_id`,`companion_id`,`runtime_epoch`,`id`);--> statement-breakpoint
CREATE INDEX `autonomy_policy_scan` ON `autonomy_policies` (`owner_id`,`companion_id`,`runtime_epoch`,`version`);--> statement-breakpoint
CREATE INDEX `autonomy_usage_window` ON `autonomy_usage` (`owner_id`,`kind`,`companion_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_intent_dispatch` ON `contact_intents` (`owner_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `contact_intent_cooldown` ON `contact_intents` (`owner_id`,`published_at`);