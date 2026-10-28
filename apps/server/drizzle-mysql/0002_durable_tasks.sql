CREATE TABLE `task_attempts` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`number` int NOT NULL,
	`config_version` int NOT NULL,
	`config` json NOT NULL,
	`status` varchar(24) NOT NULL,
	`reason` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`deadline_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `task_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_attempt_number` UNIQUE(`owner_id`,`task_id`,`number`)
);
--> statement-breakpoint
CREATE TABLE `task_configuration_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`source` varchar(24) NOT NULL,
	`config` json NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `task_configuration_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_config_version` UNIQUE(`owner_id`,`version`),
	CONSTRAINT `task_config_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `task_outbox` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`event_key` varchar(180) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`source_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_version` int NOT NULL,
	`payload` json NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'pending',
	`reason` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`dispatched_at` datetime(3),
	CONSTRAINT `task_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_outbox_event` UNIQUE(`owner_id`,`event_key`)
);
--> statement-breakpoint
CREATE TABLE `task_scheduler_heads` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `task_scheduler_heads_owner_id` PRIMARY KEY(`owner_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_key` varchar(180) NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`input` json NOT NULL,
	`scope` json NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'queued',
	`stage` varchar(64) NOT NULL DEFAULT 'queued',
	`completed_steps` int NOT NULL DEFAULT 0,
	`total_steps` int,
	`reason` varchar(64),
	`model_call_id` char(36) character set ascii collate ascii_general_ci,
	`fence` int NOT NULL DEFAULT 0,
	`lease_token` char(36) character set ascii collate ascii_general_ci,
	`lease_expires_at` datetime(3),
	`available_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `tasks_owner_request` UNIQUE(`owner_id`,`request_key`),
	CONSTRAINT `tasks_progress_valid` CHECK(`tasks`.`completed_steps` >= 0 AND `tasks`.`fence` >= 0 AND (`tasks`.`total_steps` IS NULL OR `tasks`.`completed_steps` <= `tasks`.`total_steps`))
);
--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_configuration_versions` ADD CONSTRAINT `task_configuration_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_outbox` ADD CONSTRAINT `task_outbox_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_scheduler_heads` ADD CONSTRAINT `task_scheduler_heads_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `task_outbox_dispatch` ON `task_outbox` (`owner_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_dispatch` ON `tasks` (`owner_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `tasks_expiry` ON `tasks` (`owner_id`,`status`,`lease_expires_at`);--> statement-breakpoint
-- F02/F03 已保存的逐实例待整理范围也进入恢复队列；不修改原文和读取状态。
INSERT INTO `task_outbox` (`id`, `owner_id`, `event_key`, `kind`, `source_id`, `source_version`, `payload`, `status`, `created_at`)
SELECT UUID(), p.owner_id, CONCAT('message:', p.message_id, ':', p.content_version), 'message_published', p.message_id, p.content_version,
  JSON_OBJECT('conversationId', p.conversation_id, 'messageId', p.message_id, 'contentVersion', p.content_version, 'sequence', p.start_sequence,
    'recipients', JSON_ARRAYAGG(JSON_OBJECT('companionId', p.companion_id, 'runtimeEpoch', p.runtime_epoch, 'permissionVersion', COALESCE(cm.permission_version, 1)))),
  'pending', MIN(p.created_at)
FROM processing_ranges p
LEFT JOIN conversation_members cm ON cm.owner_id = p.owner_id AND cm.conversation_id = p.conversation_id AND cm.companion_id = p.companion_id AND cm.runtime_epoch = p.runtime_epoch AND cm.kind = 'companion'
GROUP BY p.owner_id, p.conversation_id, p.message_id, p.content_version, p.start_sequence;
