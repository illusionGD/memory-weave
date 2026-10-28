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
	`task_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
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
ALTER TABLE `persona_versions` ADD `document` json;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `origin` varchar(24) DEFAULT 'initial_text' NOT NULL;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `parent_version_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `model_call_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `mode` varchar(12);--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `command_id` char(36) character set ascii collate ascii_general_ci;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD `command_fingerprint` varchar(64);--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_command` UNIQUE(`owner_id`,`companion_id`,`command_id`);--> statement-breakpoint
ALTER TABLE `persona_foundations` ADD CONSTRAINT `persona_foundations_companion` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_foundations` ADD CONSTRAINT `persona_foundations_initial` FOREIGN KEY (`owner_id`,`companion_id`,`initial_persona_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_template_versions` ADD CONSTRAINT `template_versions_parent` FOREIGN KEY (`owner_id`,`template_id`) REFERENCES `persona_templates`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_templates` ADD CONSTRAINT `persona_templates_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_parent` FOREIGN KEY (`owner_id`,`companion_id`,`parent_version_id`) REFERENCES `persona_versions`(`owner_id`,`companion_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `persona_versions` ADD CONSTRAINT `persona_versions_model_call` FOREIGN KEY (`owner_id`,`model_call_id`) REFERENCES `model_calls`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;