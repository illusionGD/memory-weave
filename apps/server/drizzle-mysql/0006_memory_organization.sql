CREATE TABLE `memory_batches` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci,
	`input` json,
	`configuration` json NOT NULL,
	`config_version` int NOT NULL,
	`mode` varchar(10) NOT NULL,
	`sequences` json NOT NULL,
	`outcomes` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `memory_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_batch_owner_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `memory_batch_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_batch_task` UNIQUE(`owner_id`,`task_id`),
	CONSTRAINT `memory_batch_epoch_positive` CHECK(`memory_batches`.`runtime_epoch` > 0 AND `memory_batches`.`config_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_dependencies` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `memory_dependencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_dependency_pair` UNIQUE(`owner_id`,`version_id`,`source_version_id`),
	CONSTRAINT `memory_dependency_no_self` CHECK(`memory_dependencies`.`version_id` <> `memory_dependencies`.`source_version_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`current_version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_entry_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_entry_state_valid` CHECK(`memory_entries`.`version` > 0 AND `memory_entries`.`runtime_epoch` > 0 AND `memory_entries`.`status` IN ('active','disputed','invalidated'))
);
--> statement-breakpoint
CREATE TABLE `memory_evidence` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`start_offset` int NOT NULL,
	`end_offset` int NOT NULL,
	`kind` varchar(12) NOT NULL,
	CONSTRAINT `memory_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_evidence_exact` UNIQUE(`owner_id`,`version_id`,`message_id`,`content_version`,`start_offset`,`end_offset`,`kind`),
	CONSTRAINT `memory_evidence_range_valid` CHECK(`memory_evidence`.`content_version` > 0 AND `memory_evidence`.`start_offset` >= 0 AND `memory_evidence`.`end_offset` >= `memory_evidence`.`start_offset` AND `memory_evidence`.`kind` IN ('quote','context'))
);
--> statement-breakpoint
CREATE TABLE `memory_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`memory_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`batch_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`document` json,
	`fingerprint` varchar(64) NOT NULL,
	`operation` varchar(16) NOT NULL,
	`previous_version_id` char(36) character set ascii collate ascii_general_ci,
	`reason` varchar(400),
	`mode` varchar(10) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`invalidated_at` datetime(3),
	CONSTRAINT `memory_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_version_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_version_number` UNIQUE(`owner_id`,`memory_id`,`version`),
	CONSTRAINT `memory_version_positive` CHECK(`memory_versions`.`version` > 0)
);
--> statement-breakpoint
ALTER TABLE `processing_ranges` DROP CONSTRAINT `processing_ranges_stage_valid`;--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD `batch_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batches_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batch_companion_fk` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batch_conversation_fk` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_dependencies` ADD CONSTRAINT `memory_dependency_version_fk` FOREIGN KEY (`owner_id`,`version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_dependencies` ADD CONSTRAINT `memory_dependency_source_fk` FOREIGN KEY (`owner_id`,`source_version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entries_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entry_companion_fk` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entry_conversation_fk` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_version_fk` FOREIGN KEY (`owner_id`,`version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_message_fk` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_batch_id_memory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `memory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_version_entry_fk` FOREIGN KEY (`owner_id`,`memory_id`) REFERENCES `memory_entries`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_version_batch_fk` FOREIGN KEY (`owner_id`,`batch_id`) REFERENCES `memory_batches`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `memory_batch_scope` ON `memory_batches` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `memory_dependency_source` ON `memory_dependencies` (`owner_id`,`source_version_id`);--> statement-breakpoint
CREATE INDEX `memory_entry_scope` ON `memory_entries` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `memory_evidence_source` ON `memory_evidence` (`owner_id`,`message_id`,`content_version`);--> statement-breakpoint
CREATE INDEX `memory_evidence_version` ON `memory_evidence` (`owner_id`,`version_id`);--> statement-breakpoint
CREATE INDEX `memory_version_fingerprint` ON `memory_versions` (`owner_id`,`fingerprint`);--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD CONSTRAINT `processing_ranges_stage_valid` CHECK (`processing_ranges`.`stage` = 'memory_extraction' AND `processing_ranges`.`status` IN ('pending', 'processing', 'processed'));--> statement-breakpoint
CREATE INDEX `processing_ranges_pending_idx` ON `processing_ranges` (`owner_id`,`status`,`companion_id`,`runtime_epoch`,`conversation_id`,`created_at`);