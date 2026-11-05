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
CREATE TABLE `chat_memory_sources` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `chat_memory_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `chat_memory_source_unique` UNIQUE(`owner_id`,`run_id`,`version_id`)
);
--> statement-breakpoint
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
	CONSTRAINT `chat_runs_conversation_id` UNIQUE(`owner_id`,`conversation_id`,`id`),
	CONSTRAINT `chat_runs_request` UNIQUE(`owner_id`,`conversation_id`,`request_id`)
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
CREATE TABLE `companions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`name` varchar(80) NOT NULL,
	`runtime_epoch` int NOT NULL DEFAULT 1,
	`version` int NOT NULL DEFAULT 1,
	`avatar` json,
	`avatar_version` int NOT NULL DEFAULT 0,
	`initial_snapshot` json,
	`deleted_at` datetime(3),
	`lifecycle_operation_id` char(36) character set ascii collate ascii_general_ci,
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
	`deleted_at` datetime(3),
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
	`lifecycle_operation_id` char(36) character set ascii collate ascii_general_ci,
	`content_revision` int NOT NULL DEFAULT 1,
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
CREATE TABLE `lifecycle_memory_targets` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`operation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `lifecycle_memory_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_memory_target_unique` UNIQUE(`owner_id`,`operation_id`,`version_id`)
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
CREATE TABLE `memory_batches` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci,
	`input` json,
	`configuration` json NOT NULL,
	`config_version` int NOT NULL,
	`mode` varchar(10) NOT NULL,
	`sequences` json NOT NULL,
	`outcomes` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `memory_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_batch_owner_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `memory_batch_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_batch_task` UNIQUE(`owner_id`,`task_id`),
	CONSTRAINT `memory_batch_epoch_positive` CHECK(`memory_batches`.`runtime_epoch` > 0 AND `memory_batches`.`config_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_dependencies` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	CONSTRAINT `memory_dependencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_dependency_pair` UNIQUE(`owner_id`,`version_id`,`source_version_id`),
	CONSTRAINT `memory_dependency_no_self` CHECK(`memory_dependencies`.`version_id` <> `memory_dependencies`.`source_version_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`current_version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_entry_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_entry_state_valid` CHECK(`memory_entries`.`version` > 0 AND `memory_entries`.`runtime_epoch` > 0 AND `memory_entries`.`status` IN ('active','disputed','invalidated'))
);
--> statement-breakpoint
CREATE TABLE `memory_evidence` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`message_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`content_version` int NOT NULL,
	`start_offset` int NOT NULL,
	`end_offset` int NOT NULL,
	`kind` varchar(12) NOT NULL,
	CONSTRAINT `memory_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_evidence_exact` UNIQUE(`owner_id`,`version_id`,`message_id`,`content_version`,`start_offset`,`end_offset`,`kind`),
	CONSTRAINT `memory_evidence_range_valid` CHECK(`memory_evidence`.`content_version` > 0 AND `memory_evidence`.`start_offset` >= 0 AND `memory_evidence`.`end_offset` >= `memory_evidence`.`start_offset` AND `memory_evidence`.`kind` IN ('quote','context'))
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
CREATE TABLE `memory_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`memory_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`batch_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`document` json,
	`fingerprint` varchar(64) NOT NULL,
	`operation` varchar(16) NOT NULL,
	`previous_version_id` char(36) character set ascii collate ascii_general_ci,
	`reason` varchar(400),
	`mode` varchar(10) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`invalidated_at` datetime(3),
	CONSTRAINT `memory_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `memory_version_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `memory_version_number` UNIQUE(`owner_id`,`memory_id`,`version`),
	CONSTRAINT `memory_version_positive` CHECK(`memory_versions`.`version` > 0)
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
	`content_version` int NOT NULL DEFAULT 1,
	`revision` int NOT NULL DEFAULT 1,
	`text` text NOT NULL,
	`deleted_at` datetime(3),
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
	`chat_run_id` char(36) character set ascii collate ascii_general_ci,
	`chat_position` int,
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
	CONSTRAINT `messages_chat_position` UNIQUE(`owner_id`,`chat_run_id`,`chat_position`),
	CONSTRAINT `messages_chat_pair` CHECK((`messages`.`chat_run_id` IS NULL AND `messages`.`chat_position` IS NULL) OR (`messages`.`chat_run_id` IS NOT NULL AND `messages`.`chat_position` IS NOT NULL AND `messages`.`chat_position` > 0)),
	CONSTRAINT `messages_versions_positive` CHECK(`messages`.`content_version` > 0 AND `messages`.`revision` > 0),
	CONSTRAINT `messages_text_length` CHECK((`messages`.`deleted_at` IS NULL AND char_length(`messages`.`text`) BETWEEN 1 AND 4000) OR (`messages`.`deleted_at` IS NOT NULL AND char_length(`messages`.`text`) = 0)),
	CONSTRAINT `messages_publication_valid` CHECK((`messages`.`state` = 'draft' AND `messages`.`sequence` IS NULL AND `messages`.`published_at` IS NULL AND `messages`.`publish_request_id` IS NULL AND `messages`.`publish_fingerprint` IS NULL) OR (`messages`.`state` = 'published' AND `messages`.`sequence` IS NOT NULL AND `messages`.`sequence` > 0 AND `messages`.`published_at` IS NOT NULL AND `messages`.`publish_request_id` IS NOT NULL AND `messages`.`publish_fingerprint` IS NOT NULL)),
	CONSTRAINT `messages_validity_ordered` CHECK(`messages`.`valid_from` IS NULL OR `messages`.`valid_until` IS NULL OR `messages`.`valid_until` >= `messages`.`valid_from`),
	CONSTRAINT `messages_epistemic_kind_valid` CHECK(`messages`.`epistemic_kind` IN ('statement', 'report', 'inference', 'setting')),
	CONSTRAINT `messages_reality_valid` CHECK(`messages`.`reality` IN ('unspecified', 'real', 'fictional')),
	CONSTRAINT `messages_source_kind_valid` CHECK(`messages`.`source_kind` IN ('user_input', 'admin_companion_input', 'model_output'))
);
--> statement-breakpoint
CREATE TABLE `model_attempts` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`call_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`number` int NOT NULL,
	`role` varchar(32) NOT NULL,
	`lane` varchar(20) NOT NULL,
	`day` varchar(10) NOT NULL,
	`status` varchar(20) NOT NULL,
	`usage_source` varchar(20) NOT NULL,
	`input_tokens` int,
	`output_tokens` int,
	`charged_tokens` bigint NOT NULL,
	`charged_cost_micros` bigint NOT NULL,
	`error_code` int,
	`actual_model` varchar(160),
	`response_fingerprint` varchar(64),
	`started_at` datetime(3) NOT NULL,
	`deadline_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `model_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_attempt_call_number` UNIQUE(`owner_id`,`call_id`,`number`),
	CONSTRAINT `model_attempt_charge_nonnegative` CHECK(`model_attempts`.`charged_tokens` >= 0 AND `model_attempts`.`charged_cost_micros` >= 0 AND `model_attempts`.`number` > 0)
);
--> statement-breakpoint
CREATE TABLE `model_calls` (
	`context` json NOT NULL,
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`config_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`config_version` int NOT NULL,
	`role` varchar(32) NOT NULL,
	`operation` varchar(20) NOT NULL,
	`lane` varchar(20) NOT NULL,
	`provider_id` varchar(48) NOT NULL,
	`model` varchar(120) NOT NULL,
	`status` varchar(20) NOT NULL,
	`error_code` int,
	`result` json,
	`invalidated_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `model_calls_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_call_owner_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `model_call_owner_id` UNIQUE(`owner_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `model_configuration_heads` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`active_version` int NOT NULL DEFAULT 0,
	CONSTRAINT `model_configuration_heads_owner_id` PRIMARY KEY(`owner_id`)
);
--> statement-breakpoint
CREATE TABLE `model_configuration_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`source` varchar(24) NOT NULL,
	`config` json NOT NULL,
	`evaluation_note` varchar(500) NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `model_configuration_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_config_owner_version` UNIQUE(`owner_id`,`version`),
	CONSTRAINT `model_config_owner_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `model_config_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `model_config_version_positive` CHECK(`model_configuration_versions`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE `model_usage_windows` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`day` varchar(10) NOT NULL,
	`scope` varchar(32) NOT NULL,
	`requests` bigint NOT NULL DEFAULT 0,
	`tokens` bigint NOT NULL DEFAULT 0,
	`cost_micros` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `model_usage_windows_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_usage_owner_day_scope` UNIQUE(`owner_id`,`day`,`scope`),
	CONSTRAINT `model_usage_nonnegative` CHECK(`model_usage_windows`.`requests` >= 0 AND `model_usage_windows`.`tokens` >= 0 AND `model_usage_windows`.`cost_micros` >= 0)
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
CREATE TABLE `persona_foundations` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`name_override` varchar(80),
	`template` json,
	`explicit_locks` json NOT NULL,
	`task_id` char(36) character set ascii collate ascii_general_ci,
	`initial_persona_version_id` char(36) character set ascii collate ascii_general_ci,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `persona_foundations_id` PRIMARY KEY(`id`),
	CONSTRAINT `persona_foundations_scope` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`),
	CONSTRAINT `persona_foundations_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `persona_template_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`template_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`name` varchar(80) NOT NULL,
	`initial_profile` text NOT NULL,
	`locked_features` json NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `persona_template_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `template_versions_number` UNIQUE(`owner_id`,`template_id`,`version`),
	CONSTRAINT `template_versions_request` UNIQUE(`owner_id`,`template_id`,`request_id`),
	CONSTRAINT `template_versions_positive` CHECK(`persona_template_versions`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE `persona_templates` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	CONSTRAINT `persona_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `persona_templates_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `persona_templates_request` UNIQUE(`owner_id`,`request_id`),
	CONSTRAINT `persona_templates_version_positive` CHECK(`persona_templates`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE `persona_versions` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`version` int NOT NULL,
	`profile_text` text NOT NULL,
	`document` json,
	`origin` varchar(24) NOT NULL DEFAULT 'initial_text',
	`parent_version_id` char(36) character set ascii collate ascii_general_ci,
	`model_call_id` char(36) character set ascii collate ascii_general_ci,
	`mode` varchar(12),
	`command_id` char(36) character set ascii collate ascii_general_ci,
	`command_fingerprint` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `persona_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `persona_versions_owner_companion_id_unique` UNIQUE(`owner_id`,`companion_id`,`id`),
	CONSTRAINT `persona_versions_number_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`version`),
	CONSTRAINT `persona_versions_command` UNIQUE(`owner_id`,`companion_id`,`command_id`),
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
	`batch_id` char(36) character set ascii collate ascii_general_ci,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `processing_ranges_id` PRIMARY KEY(`id`),
	CONSTRAINT `processing_ranges_instance_message_unique` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`message_id`,`content_version`,`stage`),
	CONSTRAINT `processing_ranges_range_valid` CHECK(`processing_ranges`.`runtime_epoch` > 0 AND `processing_ranges`.`start_sequence` > 0 AND `processing_ranges`.`end_sequence` >= `processing_ranges`.`start_sequence`),
	CONSTRAINT `processing_ranges_stage_valid` CHECK(`processing_ranges`.`stage` = 'memory_extraction' AND `processing_ranges`.`status` IN ('pending', 'processing', 'processed'))
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
	CONSTRAINT `tasks_owner_id` UNIQUE(`owner_id`,`id`),
	CONSTRAINT `tasks_owner_request` UNIQUE(`owner_id`,`request_key`),
	CONSTRAINT `tasks_progress_valid` CHECK(`tasks`.`completed_steps` >= 0 AND `tasks`.`fence` >= 0 AND (`tasks`.`total_steps` IS NULL OR `tasks`.`completed_steps` <= `tasks`.`total_steps`))
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
ALTER TABLE `chat_deliveries` ADD CONSTRAINT `chat_deliveries_message_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_run_id_chat_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `chat_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_memory_sources` ADD CONSTRAINT `chat_memory_sources_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_run_sources` ADD CONSTRAINT `chat_run_source_run` FOREIGN KEY (`owner_id`,`run_id`) REFERENCES `chat_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_run_sources` ADD CONSTRAINT `chat_run_source_message_ref` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_thread_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `chat_threads`(`owner_id`,`conversation_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD CONSTRAINT `chat_runs_trigger_ref` FOREIGN KEY (`owner_id`,`conversation_id`,`trigger_message_id`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD CONSTRAINT `chat_threads_conversation_ref` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD CONSTRAINT `chat_threads_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companions` ADD CONSTRAINT `companions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companions` ADD CONSTRAINT `companions_current_persona_fk` FOREIGN KEY (`owner_id`,`id`,`current_persona_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD CONSTRAINT `conversation_members_ref_1` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversation_members` ADD CONSTRAINT `conversation_members_ref_2` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_operation_id_lifecycle_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `lifecycle_operations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_memory_targets` ADD CONSTRAINT `lifecycle_memory_targets_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_message_targets` ADD CONSTRAINT `lifecycle_message_targets_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_message_targets` ADD CONSTRAINT `lifecycle_target_operation` FOREIGN KEY (`operation_id`) REFERENCES `lifecycle_operations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_operations` ADD CONSTRAINT `lifecycle_operations_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batches_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batch_companion_fk` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_batches` ADD CONSTRAINT `memory_batch_conversation_fk` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_dependencies` ADD CONSTRAINT `memory_dependency_version_fk` FOREIGN KEY (`owner_id`,`version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_dependencies` ADD CONSTRAINT `memory_dependency_source_fk` FOREIGN KEY (`owner_id`,`source_version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entries_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entry_companion_fk` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_entries` ADD CONSTRAINT `memory_entry_conversation_fk` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_version_fk` FOREIGN KEY (`owner_id`,`version_id`) REFERENCES `memory_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_evidence` ADD CONSTRAINT `memory_evidence_message_fk` FOREIGN KEY (`owner_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_versions_batch_id_memory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `memory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_version_entry_fk` FOREIGN KEY (`owner_id`,`memory_id`) REFERENCES `memory_entries`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_versions` ADD CONSTRAINT `memory_version_batch_fk` FOREIGN KEY (`owner_id`,`batch_id`) REFERENCES `memory_batches`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_sources` ADD CONSTRAINT `message_sources_ref_1` FOREIGN KEY (`owner_id`,`message_id`) REFERENCES `messages`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_sources` ADD CONSTRAINT `message_sources_ref_2` FOREIGN KEY (`owner_id`,`source_message_id`,`source_content_version`) REFERENCES `messages`(`owner_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_chat_run_ref` FOREIGN KEY (`owner_id`,`conversation_id`,`chat_run_id`) REFERENCES `chat_runs`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_1` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`speaker_membership_id`) REFERENCES `conversation_members`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_ref_3` FOREIGN KEY (`owner_id`,`conversation_id`,`reply_to_message_id`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_attempts` ADD CONSTRAINT `model_attempt_call_fk` FOREIGN KEY (`owner_id`,`call_id`) REFERENCES `model_calls`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_calls_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_call_config_fk` FOREIGN KEY (`owner_id`,`config_id`) REFERENCES `model_configuration_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_configuration_heads` ADD CONSTRAINT `model_configuration_heads_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_configuration_versions` ADD CONSTRAINT `model_configuration_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_usage_windows` ADD CONSTRAINT `model_usage_windows_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_foundations` ADD CONSTRAINT `persona_foundations_companion` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_foundations` ADD CONSTRAINT `persona_foundations_initial` FOREIGN KEY (`owner_id`,`companion_id`,`initial_persona_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_template_versions` ADD CONSTRAINT `template_versions_parent` FOREIGN KEY (`owner_id`,`template_id`) REFERENCES `persona_templates`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_templates` ADD CONSTRAINT `persona_templates_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_parent` FOREIGN KEY (`owner_id`,`companion_id`,`parent_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_model_call` FOREIGN KEY (`owner_id`,`model_call_id`) REFERENCES `model_calls`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD CONSTRAINT `processing_ranges_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `processing_ranges` ADD CONSTRAINT `processing_ranges_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `read_receipts` ADD CONSTRAINT `read_receipts_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `read_receipts` ADD CONSTRAINT `read_receipts_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`,`message_id`,`content_version`) REFERENCES `messages`(`owner_id`,`conversation_id`,`id`,`content_version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receive_batches` ADD CONSTRAINT `receive_batches_ref_1` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `receive_batches` ADD CONSTRAINT `receive_batches_ref_2` FOREIGN KEY (`owner_id`,`conversation_id`) REFERENCES `conversations`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_configuration_versions` ADD CONSTRAINT `task_configuration_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_outbox` ADD CONSTRAINT `task_outbox_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_scheduler_heads` ADD CONSTRAINT `task_scheduler_heads_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visibility_grants` ADD CONSTRAINT `visibility_grants_ref_1` FOREIGN KEY (`owner_id`,`membership_id`) REFERENCES `conversation_members`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `chat_memory_source_version_idx` ON `chat_memory_sources` (`owner_id`,`version_id`);--> statement-breakpoint
CREATE INDEX `chat_run_source_message` ON `chat_run_sources` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `memory_batch_scope` ON `memory_batches` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `memory_dependency_source` ON `memory_dependencies` (`owner_id`,`source_version_id`);--> statement-breakpoint
CREATE INDEX `memory_entry_scope` ON `memory_entries` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `memory_evidence_source` ON `memory_evidence` (`owner_id`,`message_id`,`content_version`);--> statement-breakpoint
CREATE INDEX `memory_evidence_version` ON `memory_evidence` (`owner_id`,`version_id`);--> statement-breakpoint
CREATE INDEX `memory_original_source_message_idx` ON `memory_original_sources` (`owner_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `memory_search_scope_idx` ON `memory_search_documents` (`owner_id`,`companion_id`,`runtime_epoch`,`created_at`);--> statement-breakpoint
CREATE INDEX `memory_term_version_idx` ON `memory_search_terms` (`version_id`);--> statement-breakpoint
CREATE INDEX `memory_vector_scope_idx` ON `memory_vector_indexes` (`owner_id`,`companion_id`,`runtime_epoch`);--> statement-breakpoint
CREATE INDEX `memory_vector_cleanup_idx` ON `memory_vector_indexes` (`owner_id`,`status`,`reconciled_at`);--> statement-breakpoint
CREATE INDEX `memory_version_fingerprint` ON `memory_versions` (`owner_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `memory_version_time` ON `memory_versions` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `memory_version_previous` ON `memory_versions` (`owner_id`,`previous_version_id`,`id`);--> statement-breakpoint
CREATE INDEX `model_attempt_running_deadline` ON `model_attempts` (`owner_id`,`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `model_call_owner_status` ON `model_calls` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `processing_ranges_pending_idx` ON `processing_ranges` (`owner_id`,`status`,`companion_id`,`runtime_epoch`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `processing_ranges_conversation_sequence_idx` ON `processing_ranges` (`owner_id`,`companion_id`,`runtime_epoch`,`conversation_id`,`start_sequence`);--> statement-breakpoint
CREATE INDEX `task_outbox_dispatch` ON `task_outbox` (`owner_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_dispatch` ON `tasks` (`owner_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `tasks_expiry` ON `tasks` (`owner_id`,`status`,`lease_expires_at`);
--> statement-breakpoint
INSERT INTO owners (id, deployment_key, display_name) VALUES (UUID(), 'local', '用户');
