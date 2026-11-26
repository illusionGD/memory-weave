CREATE TABLE `conversation_history_shares` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`membership_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`from_sequence` int NOT NULL,
	`through_sequence` int NOT NULL,
	`state` varchar(16) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`permission_version` int NOT NULL,
	`queued_messages` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `conversation_history_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversation_history_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `conversation_history_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `conversation_history_range` CHECK(`conversation_history_shares`.`from_sequence` > 0 AND `conversation_history_shares`.`through_sequence` >= `conversation_history_shares`.`from_sequence`)
);
--> statement-breakpoint
CREATE TABLE `conversation_invitations` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`requested_by_membership_id` char(36) character set ascii collate ascii_general_ci,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`group_title` varchar(80),
	`restore_removed` boolean NOT NULL DEFAULT false,
	`state` varchar(16) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`accepted_conversation_id` char(36) character set ascii collate ascii_general_ci,
	`decided_by` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `conversation_invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversation_invite_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `conversation_invite_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_membership_commands` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`result` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `membership_command_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
ALTER TABLE `conversation_members` DROP CONSTRAINT `conversation_members_range_valid`;--> statement-breakpoint
ALTER TABLE `visibility_grants` DROP CONSTRAINT `visibility_grants_kind_valid`;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD `removed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `conversations` ADD `closed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `conversations` ADD `peer_invitations_enabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_history_shares` ADD CONSTRAINT `conversation_history_member_ref` FOREIGN KEY (`owner_id`,`conversation_id`,`membership_id`) REFERENCES `conversation_members`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_invitations` ADD CONSTRAINT `conversation_invite_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_invitations` ADD CONSTRAINT `conversation_invite_target_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_membership_commands` ADD CONSTRAINT `membership_command_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `conversation_history_membership` ON `conversation_history_shares` (`owner_id`,`membership_id`,`state`);--> statement-breakpoint
CREATE INDEX `conversation_invite_status` ON `conversation_invitations` (`owner_id`,`conversation_id`,`companion_id`,`runtime_epoch`,`state`);--> statement-breakpoint
ALTER TABLE `conversation_members` ADD CONSTRAINT `conversation_members_range_valid` CHECK (`conversation_members`.`joined_sequence` > 0 AND (`conversation_members`.`left_sequence` IS NULL OR `conversation_members`.`left_sequence` >= `conversation_members`.`joined_sequence` - 1) AND `conversation_members`.`permission_version` > 0);--> statement-breakpoint
ALTER TABLE `visibility_grants` ADD CONSTRAINT `visibility_grants_kind_valid` CHECK (`visibility_grants`.`kind` IN ('membership', 'history', 'retained'));
--> statement-breakpoint
UPDATE `visibility_grants` SET `kind` = 'retained' WHERE `kind` = 'history';
