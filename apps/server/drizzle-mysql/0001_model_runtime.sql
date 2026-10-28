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
ALTER TABLE `model_attempts` ADD CONSTRAINT `model_attempt_call_fk` FOREIGN KEY (`owner_id`,`call_id`) REFERENCES `model_calls`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_calls_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_call_config_fk` FOREIGN KEY (`owner_id`,`config_id`) REFERENCES `model_configuration_versions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_configuration_heads` ADD CONSTRAINT `model_configuration_heads_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_configuration_versions` ADD CONSTRAINT `model_configuration_versions_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_usage_windows` ADD CONSTRAINT `model_usage_windows_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `model_attempt_running_deadline` ON `model_attempts` (`owner_id`,`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `model_call_owner_status` ON `model_calls` (`owner_id`,`status`);