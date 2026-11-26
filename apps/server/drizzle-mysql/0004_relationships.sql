CREATE TABLE `relationship_sources` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	CONSTRAINT `rel_source_unique` UNIQUE(`owner_id`,`version_id`,`message_id`,`content_version`)
);
--> statement-breakpoint
CREATE TABLE `relationship_states` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`counterpart_membership_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`kind` varchar(24) NOT NULL,
	`topic` varchar(40) NOT NULL,
	`current_version` int NOT NULL,
	`last_sequence` int NOT NULL,
	CONSTRAINT `relationship_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `rel_state_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `rel_state_direction` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`counterpart_membership_id`,`kind`,`topic`),
	CONSTRAINT `rel_state_valid` CHECK(`relationship_states`.`runtime_epoch` > 0 AND `relationship_states`.`current_version` > 0 AND `relationship_states`.`last_sequence` > 0)
);
--> statement-breakpoint
CREATE TABLE `relationship_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`state_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`document` json,
	`evidence` json,
	`mode` varchar(10) NOT NULL,
	`observed_at` datetime(3) NOT NULL,
	`expires_at` datetime(3),
	`invalidated_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `relationship_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `rel_version_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `rel_version_number` UNIQUE(`owner_id`,`state_id`,`version`),
	CONSTRAINT `rel_version_batch` UNIQUE(`owner_id`,`state_id`,`task_id`)
);
--> statement-breakpoint
ALTER TABLE `relationship_sources` ADD CONSTRAINT `rel_source_version_ref` FOREIGN KEY (`owner_id`,`version_id`) REFERENCES `relationship_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationship_states` ADD CONSTRAINT `relationship_states_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationship_states` ADD CONSTRAINT `rel_state_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationship_states` ADD CONSTRAINT `rel_state_member_ref` FOREIGN KEY (`owner_id`,`conversation_id`,`counterpart_membership_id`) REFERENCES `conversation_members`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationship_versions` ADD CONSTRAINT `rel_version_state_ref` FOREIGN KEY (`owner_id`,`state_id`) REFERENCES `relationship_states`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationship_versions` ADD CONSTRAINT `rel_version_task_ref` FOREIGN KEY (`owner_id`,`task_id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rel_source_message` ON `relationship_sources` (`owner_id`,`message_id`);