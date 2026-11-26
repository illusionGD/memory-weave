CREATE TABLE `peer_policies` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`version` int NOT NULL,
	`enabled` boolean NOT NULL,
	`public_description` varchar(250),
	`invitation_decision` varchar(16) NOT NULL,
	`allow_exit` boolean NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `peer_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `peer_policy_version` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`version`),
	CONSTRAINT `peer_policy_request` UNIQUE(`owner_id`,`companion_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `peer_room_settings` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`enabled` boolean NOT NULL,
	`allow_exit` boolean NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `peer_room_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `peer_room_version` UNIQUE(`owner_id`,`conversation_id`,`version`),
	CONSTRAINT `peer_room_request` UNIQUE(`owner_id`,`conversation_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `peer_session_attempts` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`session_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`call_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`attempt` int NOT NULL,
	CONSTRAINT `peer_attempt_once` UNIQUE(`owner_id`,`session_id`,`call_id`,`attempt`)
);
--> statement-breakpoint
CREATE TABLE `peer_sessions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`trigger_message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`topic_fingerprint` varchar(64),
	`room_version` int NOT NULL,
	`max_calls` int NOT NULL,
	`max_output_tokens` int NOT NULL,
	`max_cost_micros` int NOT NULL,
	`reason` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `peer_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `peer_session_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `peer_session_trigger` UNIQUE(`owner_id`,`trigger_message_id`)
);
--> statement-breakpoint
ALTER TABLE `autonomy_opportunities` ADD `invitation_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `peer_room_settings` ADD CONSTRAINT `peer_room_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `peer_session_attempts` ADD CONSTRAINT `peer_attempt_session_ref` FOREIGN KEY (`owner_id`,`session_id`) REFERENCES `peer_sessions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `peer_sessions` ADD CONSTRAINT `peer_session_turn_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `group_turns`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `peer_session_topic` ON `peer_sessions` (`owner_id`,`topic_fingerprint`,`created_at`);