CREATE TABLE `chat_run_sources` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	CONSTRAINT `chat_run_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_run_source` UNIQUE(`owner_id`,`run_id`,`message_id`)
);
--> statement-breakpoint
CREATE TABLE `lifecycle_message_targets` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`operation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`kind` varchar(16) NOT NULL,
	CONSTRAINT `lifecycle_message_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_message_target` UNIQUE(`owner_id`,`operation_id`,`message_id`)
);
--> statement-breakpoint
CREATE TABLE `lifecycle_operations` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`protocol_version` int NOT NULL DEFAULT 1,
	`fingerprint` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci,
	`conversation_id` char(36) character set ascii collate ascii_general_ci,
	`previous_epoch` int,
	`next_epoch` int,
	`stage` int NOT NULL DEFAULT 0,
	`processed_records` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `lifecycle_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_owner_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
ALTER TABLE `messages` DROP CONSTRAINT `messages_text_length`;--> statement-breakpoint
ALTER TABLE `companions` MODIFY COLUMN `initial_snapshot` json;--> statement-breakpoint
ALTER TABLE `persona_foundations` MODIFY COLUMN `task_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `companions` ADD `deleted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `companions` ADD `lifecycle_operation_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD `deleted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `conversations` ADD `lifecycle_operation_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `conversations` ADD `content_revision` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` datetime(3);--> statement-breakpoint
ALTER TABLE `model_calls` ADD `invalidated_at` datetime(3);--> statement-breakpoint
ALTER TABLE `chat_run_sources` ADD CONSTRAINT `chat_run_source_run` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `chat_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_run_sources` ADD CONSTRAINT `chat_run_source_message_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_message_targets` ADD CONSTRAINT `lifecycle_message_targets_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_message_targets` ADD CONSTRAINT `lifecycle_target_operation` FOREIGN KEY (`operation_id`) REFERENCES `lifecycle_operations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_operations` ADD CONSTRAINT `lifecycle_operations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `chat_run_source_message` ON `chat_run_sources` (`owner_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_text_length` CHECK ((`messages`.`deleted_at` IS NULL AND char_length(`messages`.`text`) BETWEEN 1 AND 4000) OR (`messages`.`deleted_at` IS NOT NULL AND char_length(`messages`.`text`) = 0));
--> statement-breakpoint
INSERT INTO chat_run_sources (id, owner_id, run_id, message_id, content_version)
SELECT UUID(), r.owner_id, r.id, j.message_id, j.content_version
FROM chat_runs r
JOIN JSON_TABLE(r.context, '$.sources[*]' COLUMNS (
  message_id CHAR(36) PATH '$.messageId', content_version INT PATH '$.contentVersion'
)) j;
