CREATE TABLE `chat_memory_sources` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `chat_memory_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_memory_source_unique` UNIQUE(`owner_id`,`run_id`,`version_id`)
);
--> statement-breakpoint
CREATE TABLE `lifecycle_memory_targets` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`operation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `lifecycle_memory_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_memory_target_unique` UNIQUE(`owner_id`,`operation_id`,`version_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_original_sources` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	CONSTRAINT `memory_original_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_original_source_unique` UNIQUE(`owner_id`,`version_id`,`message_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_search_documents` (
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`memory_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`lexical_version` varchar(40),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_search_documents_version_id` PRIMARY KEY(`version_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_search_terms` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`term` varchar(96) NOT NULL,
	CONSTRAINT `memory_search_terms_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_term_unique` UNIQUE(`owner_id`,`term`,`version_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_vector_indexes` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`memory_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`space` varchar(64) NOT NULL,
	`collection` varchar(96) NOT NULL,
	`config_version` int NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`indexed_at` datetime(3),
	`reconciled_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_vector_indexes_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_vector_space_unique` UNIQUE(`owner_id`,`version_id`,`space`)
);
--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_run_id_chat_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `chat_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_operation_id_lifecycle_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `lifecycle_operations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_original_sources` ADD CONSTRAINT `memory_original_sources_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_original_sources` ADD CONSTRAINT `memory_original_sources_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_original_sources` ADD CONSTRAINT `memory_original_sources_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_documents` ADD CONSTRAINT `memory_search_documents_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_documents` ADD CONSTRAINT `memory_search_documents_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_documents` ADD CONSTRAINT `memory_search_documents_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_documents` ADD CONSTRAINT `memory_search_documents_companion_id_companions_id_fk` FOREIGN KEY (`companion_id`) REFERENCES `companions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_documents` ADD CONSTRAINT `memory_search_documents_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_terms` ADD CONSTRAINT `memory_search_terms_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_search_terms` ADD CONSTRAINT `memory_search_terms_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_companion_id_companions_id_fk` FOREIGN KEY (`companion_id`) REFERENCES `companions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_vector_indexes` ADD CONSTRAINT `memory_vector_indexes_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `chat_memory_source_version_idx` ON `chat_memory_sources` (`owner_id`,`version_id`);--> statement-breakpoint
CREATE INDEX `memory_original_source_message_idx` ON `memory_original_sources` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `memory_search_scope_idx` ON `memory_search_documents` (`owner_id`,`companion_id`,`runtime_epoch`,`created_at`);--> statement-breakpoint
CREATE INDEX `memory_term_version_idx` ON `memory_search_terms` (`version_id`);--> statement-breakpoint
CREATE INDEX `memory_vector_scope_idx` ON `memory_vector_indexes` (`owner_id`,`companion_id`,`runtime_epoch`);--> statement-breakpoint
CREATE INDEX `memory_vector_cleanup_idx` ON `memory_vector_indexes` (`owner_id`,`status`,`reconciled_at`);
--> statement-breakpoint
INSERT INTO `memory_original_sources` (`id`, `owner_id`, `version_id`, `message_id`, `content_version`) SELECT UUID(), `owner_id`, `version_id`, `message_id`, `content_version` FROM `memory_evidence` GROUP BY `owner_id`, `version_id`, `message_id`, `content_version`;
