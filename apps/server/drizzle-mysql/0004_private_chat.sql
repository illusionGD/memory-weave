CREATE TABLE `chat_deliveries` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`terminal_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`delivered_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chat_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_deliveries_message_terminal` UNIQUE(`owner_id`,`message_id`,`content_version`,`terminal_id`)
);
--> statement-breakpoint
CREATE TABLE `chat_runs` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`trigger_message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`interrupted_at` datetime(3),
	`first_user_sequence` int NOT NULL,
	`batch_started_at` datetime(3) NOT NULL,
	`configuration` json NOT NULL,
	`context` json,
	`model_config_version` int,
	`mode` varchar(16),
	`transport` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chat_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_runs_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `chat_runs_request` UNIQUE(`owner_id`,`conversation_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `chat_segments` (
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `chat_segments_message_id` PRIMARY KEY(`message_id`),
	CONSTRAINT `chat_segments_run_position` UNIQUE(`owner_id`,`run_id`,`position`),
	CONSTRAINT `chat_segments_position_positive` CHECK(`chat_segments`.`position` > 0)
);
--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`current_run_id` char(36) character set ascii collate ascii_general_ci,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chat_threads_conversation_id` PRIMARY KEY(`conversation_id`),
	CONSTRAINT `chat_threads_owner_conversation` UNIQUE(`owner_id`,`conversation_id`),
	CONSTRAINT `chat_threads_epoch_positive` CHECK(`chat_threads`.`runtime_epoch` > 0)
);
--> statement-breakpoint
ALTER TABLE `messages` DROP CONSTRAINT `messages_source_kind_valid`;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_owner_id` UNIQUE(`owner_id`,`id`);--> statement-breakpoint
ALTER TABLE `chat_deliveries` ADD CONSTRAINT `chat_deliveries_message_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_thread_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `chat_threads`(`owner_id`,`conversation_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_trigger_ref` FOREIGN KEY (`owner_id`,`conversation_id`,`trigger_message_id`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_segments` ADD CONSTRAINT `chat_segments_run_ref` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `chat_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_segments` ADD CONSTRAINT `chat_segments_message_ref` FOREIGN KEY (`owner_id`,`message_id`) REFERENCES `messages`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD CONSTRAINT `chat_threads_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD CONSTRAINT `chat_threads_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_source_kind_valid` CHECK (`messages`.`source_kind` IN ('user_input', 'admin_companion_input', 'model_output'));