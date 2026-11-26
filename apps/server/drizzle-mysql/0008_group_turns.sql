CREATE TABLE `group_turn_heads` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`turn_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `group_turn_heads_conversation_id` PRIMARY KEY(`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `group_turn_steps` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`turn_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`ordinal` int NOT NULL,
	`membership_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`preparation` json,
	`published_message_id` char(36) character set ascii collate ascii_general_ci,
	`model_call_id` char(36) character set ascii collate ascii_general_ci,
	`completed_at` datetime(3),
	CONSTRAINT `group_turn_step_order` UNIQUE(`owner_id`,`turn_id`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `group_turns` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`trigger_message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`trigger_content_version` int NOT NULL,
	`trigger_sequence` int NOT NULL,
	`origin` varchar(16) NOT NULL,
	`addressing` varchar(16) NOT NULL,
	`mode` varchar(10) NOT NULL,
	`interrupted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `group_turns_id` PRIMARY KEY(`id`),
	CONSTRAINT `group_turn_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `group_turn_request` UNIQUE(`owner_id`,`conversation_id`,`request_id`)
);
--> statement-breakpoint
ALTER TABLE `group_turn_heads` ADD CONSTRAINT `group_turn_head_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `group_turn_steps` ADD CONSTRAINT `group_turn_step_turn_ref` FOREIGN KEY (`owner_id`,`turn_id`) REFERENCES `group_turns`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `group_turns` ADD CONSTRAINT `group_turn_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `group_turns` ADD CONSTRAINT `group_turn_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;