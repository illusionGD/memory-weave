CREATE TABLE `companions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`name` varchar(80) NOT NULL,
	`runtime_epoch` int NOT NULL DEFAULT 1,
	`version` int NOT NULL DEFAULT 1,
	`initial_snapshot` json NOT NULL,
	`current_persona_version_id` char(36) character set ascii collate ascii_general_ci,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `companions_id` PRIMARY KEY(`id`),
	CONSTRAINT `companions_owner_id_unique` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `companions_request_unique` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `companions_versions_positive` CHECK(`companions`.`runtime_epoch` > 0 AND `companions`.`version` > 0),
	CONSTRAINT `companions_name_length` CHECK(char_length(`companions`.`name`) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`kind` varchar(32) NOT NULL,
	`user_id` char(36) character set ascii collate ascii_general_ci,
	`companion_id` char(36) character set ascii collate ascii_general_ci,
	`runtime_epoch` int,
	`joined_sequence` int NOT NULL DEFAULT 1,
	`left_sequence` int,
	`permission_version` int NOT NULL DEFAULT 1,
	CONSTRAINT `conversation_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversation_members_owner_id_unique` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `conversation_members_conversation_id_unique` UNIQUE(`owner_id`,`conversation_id`,`id`),
	CONSTRAINT `conversation_members_user_unique` UNIQUE(`owner_id`,`conversation_id`,`user_id`),
	CONSTRAINT `conversation_members_companion_unique` UNIQUE(`owner_id`,`conversation_id`,`companion_id`,`runtime_epoch`),
	CONSTRAINT `conversation_members_identity_valid` CHECK((`conversation_members`.`kind` = 'user' AND `conversation_members`.`user_id` = `conversation_members`.`owner_id` AND `conversation_members`.`user_id` IS NOT NULL AND `conversation_members`.`companion_id` IS NULL AND `conversation_members`.`runtime_epoch` IS NULL) OR (`conversation_members`.`kind` = 'companion' AND `conversation_members`.`user_id` IS NULL AND `conversation_members`.`companion_id` IS NOT NULL AND `conversation_members`.`runtime_epoch` IS NOT NULL AND `conversation_members`.`runtime_epoch` > 0)),
	CONSTRAINT `conversation_members_range_valid` CHECK(`conversation_members`.`joined_sequence` > 0 AND (`conversation_members`.`left_sequence` IS NULL OR `conversation_members`.`left_sequence` >= `conversation_members`.`joined_sequence`) AND `conversation_members`.`permission_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`kind` varchar(32) NOT NULL,
	`title` varchar(80) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`last_sequence` int NOT NULL DEFAULT 0,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversations_owner_id_unique` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `conversations_request_unique` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `conversations_kind_valid` CHECK(`conversations`.`kind` IN ('private', 'group')),
	CONSTRAINT `conversations_versions_positive` CHECK(`conversations`.`version` > 0 AND `conversations`.`last_sequence` >= 0),
	CONSTRAINT `conversations_title_length` CHECK(char_length(`conversations`.`title`) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE `message_sources` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_content_version` int NOT NULL,
	`relation` varchar(32) NOT NULL,
	CONSTRAINT `message_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `message_sources_reference_unique` UNIQUE(`owner_id`,`message_id`,`source_message_id`,`source_content_version`,`relation`),
	CONSTRAINT `message_sources_relation_valid` CHECK(`message_sources`.`relation` IN ('reference', 'report')),
	CONSTRAINT `message_sources_not_self` CHECK(`message_sources`.`message_id` <> `message_sources`.`source_message_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`speaker_membership_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`schema_version` int NOT NULL DEFAULT 1,
	`content_version` int NOT NULL DEFAULT 1,
	`revision` int NOT NULL DEFAULT 1,
	`text` text NOT NULL,
	`state` varchar(32) NOT NULL DEFAULT 'draft',
	`sequence` int,
	`occurred_at` datetime(3),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`published_at` datetime(3),
	`valid_from` datetime(3),
	`valid_until` datetime(3),
	`epistemic_kind` varchar(32) NOT NULL DEFAULT 'statement',
	`reality` varchar(32) NOT NULL DEFAULT 'unspecified',
	`source_kind` varchar(32) NOT NULL,
	`reply_to_message_id` char(36) character set ascii collate ascii_general_ci,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`publish_request_id` char(36) character set ascii collate ascii_general_ci,
	`publish_fingerprint` varchar(64),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `messages_owner_id_unique` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `messages_conversation_id_unique` UNIQUE(`owner_id`,`conversation_id`,`id`),
	CONSTRAINT `messages_content_version_unique` UNIQUE(`owner_id`,`id`,`content_version`),
	CONSTRAINT `messages_conversation_content_unique` UNIQUE(`owner_id`,`conversation_id`,`id`,`content_version`),
	CONSTRAINT `messages_sequence_unique` UNIQUE(`owner_id`,`conversation_id`,`sequence`),
	CONSTRAINT `messages_request_unique` UNIQUE(`owner_id`,`conversation_id`,`request_id`),
	CONSTRAINT `messages_publish_request_unique` UNIQUE(`owner_id`,`conversation_id`,`publish_request_id`),
	CONSTRAINT `messages_versions_positive` CHECK(`messages`.`schema_version` > 0 AND `messages`.`content_version` > 0 AND `messages`.`revision` > 0),
	CONSTRAINT `messages_text_length` CHECK(char_length(`messages`.`text`) BETWEEN 1 AND 4000),
	CONSTRAINT `messages_publication_valid` CHECK((`messages`.`state` = 'draft' AND `messages`.`sequence` IS NULL AND `messages`.`published_at` IS NULL AND `messages`.`publish_request_id` IS NULL AND `messages`.`publish_fingerprint` IS NULL) OR (`messages`.`state` = 'published' AND `messages`.`sequence` IS NOT NULL AND `messages`.`sequence` > 0 AND `messages`.`published_at` IS NOT NULL AND `messages`.`publish_request_id` IS NOT NULL AND `messages`.`publish_fingerprint` IS NOT NULL)),
	CONSTRAINT `messages_validity_ordered` CHECK(`messages`.`valid_from` IS NULL OR `messages`.`valid_until` IS NULL OR `messages`.`valid_until` >= `messages`.`valid_from`),
	CONSTRAINT `messages_epistemic_kind_valid` CHECK(`messages`.`epistemic_kind` IN ('statement', 'report', 'inference', 'setting')),
	CONSTRAINT `messages_reality_valid` CHECK(`messages`.`reality` IN ('unspecified', 'real', 'fictional')),
	CONSTRAINT `messages_source_kind_valid` CHECK(`messages`.`source_kind` IN ('user_input', 'admin_companion_input'))
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`deployment_key` varchar(32) NOT NULL DEFAULT 'local',
	`display_name` varchar(80) NOT NULL DEFAULT '用户',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `owners_id` PRIMARY KEY(`id`),
	CONSTRAINT `owners_deployment_key_unique` UNIQUE(`deployment_key`),
	CONSTRAINT `owners_display_name_length` CHECK(char_length(trim(`owners`.`display_name`)) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE `persona_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`version` int NOT NULL,
	`profile_text` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `persona_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `persona_versions_owner_companion_id_unique` UNIQUE(`owner_id`,`companion_id`,`id`),
	CONSTRAINT `persona_versions_number_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`version`),
	CONSTRAINT `persona_versions_positive` CHECK(`persona_versions`.`runtime_epoch` > 0 AND `persona_versions`.`version` > 0),
	CONSTRAINT `persona_versions_profile_length` CHECK(char_length(`persona_versions`.`profile_text`) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE `processing_ranges` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`start_sequence` int NOT NULL,
	`end_sequence` int NOT NULL,
	`stage` varchar(32) NOT NULL DEFAULT 'memory_extraction',
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `processing_ranges_id` PRIMARY KEY(`id`),
	CONSTRAINT `processing_ranges_instance_message_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`message_id`,`content_version`,`stage`),
	CONSTRAINT `processing_ranges_range_valid` CHECK(`processing_ranges`.`runtime_epoch` > 0 AND `processing_ranges`.`start_sequence` > 0 AND `processing_ranges`.`end_sequence` >= `processing_ranges`.`start_sequence`),
	CONSTRAINT `processing_ranges_stage_valid` CHECK(`processing_ranges`.`stage` = 'memory_extraction' AND `processing_ranges`.`status` = 'pending')
);
--> statement-breakpoint
CREATE TABLE `read_receipts` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`acquired_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`start_offset` int NOT NULL,
	`end_offset` int NOT NULL,
	CONSTRAINT `read_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `read_receipts_instance_message_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`message_id`,`content_version`),
	CONSTRAINT `read_receipts_range_valid` CHECK(`read_receipts`.`runtime_epoch` > 0 AND `read_receipts`.`start_offset` >= 0 AND `read_receipts`.`end_offset` >= `read_receipts`.`start_offset`)
);
--> statement-breakpoint
CREATE TABLE `receive_batches` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`messages` json NOT NULL,
	`acquired_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `receive_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `receive_batches_request_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`request_id`),
	CONSTRAINT `receive_batches_epoch_positive` CHECK(`receive_batches`.`runtime_epoch` > 0),
	CONSTRAINT `receive_batches_messages_array` CHECK(JSON_TYPE(`receive_batches`.`messages`) = 'ARRAY')
);
--> statement-breakpoint
CREATE TABLE `visibility_grants` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`membership_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`start_sequence` int NOT NULL,
	`end_sequence` int,
	`kind` varchar(32) NOT NULL,
	`permission_version` int NOT NULL,
	CONSTRAINT `visibility_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `visibility_grants_range_unique` UNIQUE(`owner_id`,`membership_id`,`kind`,`start_sequence`,`permission_version`),
	CONSTRAINT `visibility_grants_kind_valid` CHECK(`visibility_grants`.`kind` IN ('membership', 'history')),
	CONSTRAINT `visibility_grants_range_valid` CHECK(`visibility_grants`.`start_sequence` > 0 AND (`visibility_grants`.`end_sequence` IS NULL OR `visibility_grants`.`end_sequence` >= `visibility_grants`.`start_sequence`) AND `visibility_grants`.`permission_version` > 0)
);
--> statement-breakpoint
ALTER TABLE `companions` ADD CONSTRAINT `companions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companions` ADD CONSTRAINT `companions_current_persona_fk` FOREIGN KEY (`owner_id`,`id`,`current_persona_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD CONSTRAINT `conversation_members_ref_1` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD CONSTRAINT `conversation_members_ref_2` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_sources` ADD CONSTRAINT `message_sources_ref_1` FOREIGN KEY (`owner_id`,`message_id`) REFERENCES `messages`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_sources` ADD CONSTRAINT `message_sources_ref_2` FOREIGN KEY (`owner_id`,`source_message_id`,`source_content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_1` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`speaker_membership_id`) REFERENCES `conversation_members`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_3` FOREIGN KEY (`owner_id`,`conversation_id`,`reply_to_message_id`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD CONSTRAINT `processing_ranges_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD CONSTRAINT `processing_ranges_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `read_receipts` ADD CONSTRAINT `read_receipts_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `read_receipts` ADD CONSTRAINT `read_receipts_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receive_batches` ADD CONSTRAINT `receive_batches_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receive_batches` ADD CONSTRAINT `receive_batches_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visibility_grants` ADD CONSTRAINT `visibility_grants_ref_1` FOREIGN KEY (`owner_id`,`membership_id`) REFERENCES `conversation_members`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `processing_ranges_conversation_sequence_idx` ON `processing_ranges` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`start_sequence`);
--> statement-breakpoint
INSERT INTO owners (id, deployment_key, display_name) VALUES (UUID(), 'local', '用户');
