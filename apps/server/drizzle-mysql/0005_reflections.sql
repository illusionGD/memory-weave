CREATE TABLE `reflection_events` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`kind` varchar(16) NOT NULL,
	`source_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_version` int NOT NULL,
	`mode` varchar(10) NOT NULL,
	`priority` int NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`task_id` char(36) character set ascii collate ascii_general_ci,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reflection_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `reflection_event_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `reflection_event_source` UNIQUE(`owner_id`,`kind`,`source_id`,`source_version`),
	CONSTRAINT `reflection_event_versions` CHECK(`reflection_events`.`runtime_epoch` > 0 AND `reflection_events`.`source_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `reflection_findings` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`root_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`kind` varchar(16) NOT NULL,
	`topic` varchar(48) NOT NULL,
	`version` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`mode` varchar(10) NOT NULL,
	`document` json,
	`evidence` json,
	`erased_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reflection_findings_id` PRIMARY KEY(`id`),
	CONSTRAINT `reflection_finding_version` UNIQUE(`owner_id`,`root_id`,`version`),
	CONSTRAINT `reflection_finding_topic` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`mode`,`kind`,`topic`,`version`)
);
--> statement-breakpoint
CREATE TABLE `reflection_run_events` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`event_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `reflection_run_event_unique` UNIQUE(`owner_id`,`run_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `reflection_run_messages` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	CONSTRAINT `reflection_run_message_unique` UNIQUE(`owner_id`,`run_id`,`message_id`,`content_version`)
);
--> statement-breakpoint
CREATE TABLE `reflection_runs` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`mode` varchar(10) NOT NULL,
	`input` json,
	`result` json,
	`event_count` int NOT NULL,
	`invalidated_at` datetime(3),
	`redacted_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reflection_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `reflection_run_owner_id` UNIQUE(`owner_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `reflection_events` ADD CONSTRAINT `reflection_events_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_events` ADD CONSTRAINT `reflection_event_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_events` ADD CONSTRAINT `reflection_event_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_findings` ADD CONSTRAINT `reflection_finding_run_ref` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `reflection_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_run_events` ADD CONSTRAINT `reflection_run_event_run_ref` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `reflection_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_run_events` ADD CONSTRAINT `reflection_run_event_source_ref` FOREIGN KEY (`owner_id`,`event_id`) REFERENCES `reflection_events`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_run_messages` ADD CONSTRAINT `reflection_run_message_run_ref` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `reflection_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reflection_runs` ADD CONSTRAINT `reflection_run_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reflection_event_queue` ON `reflection_events` (`owner_id`,`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `reflection_event_task` ON `reflection_events` (`owner_id`,`task_id`,`status`);--> statement-breakpoint
CREATE INDEX `reflection_finding_scope` ON `reflection_findings` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `reflection_run_event_source` ON `reflection_run_events` (`owner_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `reflection_run_message_source` ON `reflection_run_messages` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `reflection_run_budget` ON `reflection_runs` (`owner_id`,`companion_id`,`created_at`);