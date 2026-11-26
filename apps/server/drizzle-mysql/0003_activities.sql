CREATE TABLE `activities` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`current_version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `activities_id` PRIMARY KEY(`id`),
	CONSTRAINT `activities_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `activities_version_positive` CHECK(`activities`.`current_version` > 0 AND `activities`.`runtime_epoch` > 0)
);
--> statement-breakpoint
CREATE TABLE `activity_versions` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`activity_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64),
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`specification` json,
	`source_message_id` char(36) character set ascii collate ascii_general_ci,
	`action_source_message_id` char(36) character set ascii collate ascii_general_ci,
	`preparation` json,
	`artifact` json,
	`acknowledged_at` datetime(3),
	`redacted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `activity_versions_version` UNIQUE(`owner_id`,`activity_id`,`version`),
	CONSTRAINT `activity_versions_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `activity_versions_version_positive` CHECK(`activity_versions`.`version` > 0)
);
--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `activities_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `activities_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activities` ADD CONSTRAINT `activities_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_versions` ADD CONSTRAINT `activity_versions_activity_ref` FOREIGN KEY (`owner_id`,`activity_id`) REFERENCES `activities`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_versions` ADD CONSTRAINT `activity_versions_task_ref` FOREIGN KEY (`owner_id`,`task_id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `activities_scope` ON `activities` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `activity_versions_source` ON `activity_versions` (`owner_id`,`source_message_id`);--> statement-breakpoint
CREATE INDEX `activity_versions_action_source` ON `activity_versions` (`owner_id`,`action_source_message_id`);