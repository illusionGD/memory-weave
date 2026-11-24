CREATE TABLE `material_parts` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`material_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`position` int NOT NULL,
	`page` int,
	`status` varchar(16) NOT NULL,
	`text` mediumtext,
	`region` json,
	`asset` json,
	CONSTRAINT `mat_part_position` UNIQUE(`owner_id`,`material_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `material_readings` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`material_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`batch` int NOT NULL DEFAULT 0,
	`summary` text,
	`corrected_by_message_id` char(36) character set ascii collate ascii_general_ci,
	`model_request_id` char(36) character set ascii collate ascii_general_ci,
	`model_call_id` char(36) character set ascii collate ascii_general_ci,
	`region` json,
	`excerpts` json NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mat_read_key` UNIQUE(`owner_id`,`run_id`,`material_id`,`message_id`,`batch`)
);
--> statement-breakpoint
CREATE TABLE `material_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci,
	`kind` varchar(16) NOT NULL,
	`title` varchar(512) NOT NULL,
	`fingerprint` varchar(64),
	`file_id` char(36) character set ascii collate ascii_general_ci,
	`hash` varchar(64),
	`byte_length` int NOT NULL DEFAULT 0,
	`source_url` text,
	`final_url` text,
	`acquired_at` datetime(3),
	`shared_at` datetime(3),
	`state` varchar(16) NOT NULL DEFAULT 'pending',
	`reason` varchar(64),
	`part_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `material_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mat_ver_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `mat_ver_owner_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `message_materials` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`material_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `msg_mat_position` UNIQUE(`owner_id`,`message_id`,`content_version`,`position`),
	CONSTRAINT `msg_mat_version` UNIQUE(`owner_id`,`message_id`,`content_version`,`material_id`)
);
--> statement-breakpoint
ALTER TABLE `memory_evidence` DROP INDEX `memory_evidence_exact`;--> statement-breakpoint
ALTER TABLE `messages` DROP CONSTRAINT `messages_text_length`;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD `material` json;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD `locator_hash` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_exact` UNIQUE(`owner_id`,`version_id`,`message_id`,`content_version`,`start_offset`,`end_offset`,`kind`,`locator_hash`);--> statement-breakpoint
ALTER TABLE `material_parts` ADD CONSTRAINT `mat_part_version_ref` FOREIGN KEY (`owner_id`,`material_id`) REFERENCES `material_versions`(`owner_id`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `material_readings` ADD CONSTRAINT `mat_read_share_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`,`material_id`) REFERENCES `message_materials`(`owner_id`,`message_id`,`content_version`,`material_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `material_versions` ADD CONSTRAINT `material_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_materials` ADD CONSTRAINT `msg_mat_message_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_materials` ADD CONSTRAINT `msg_mat_version_ref` FOREIGN KEY (`owner_id`,`material_id`) REFERENCES `material_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mat_read_version` ON `material_readings` (`owner_id`,`material_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `mat_ver_expiration` ON `material_versions` (`owner_id`,`shared_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_text_length` CHECK ((`messages`.`deleted_at` IS NULL AND char_length(`messages`.`text`) BETWEEN IF(`messages`.`source_kind` = 'user_input', 0, 1) AND 4000) OR (`messages`.`deleted_at` IS NOT NULL AND char_length(`messages`.`text`) = 0));