CREATE TABLE `growth_candidates` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`conversation_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`source_run_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`expected_persona_version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`expected_control_version` int NOT NULL,
	`adopted_persona_version_id` char(36) character set ascii collate ascii_general_ci,
	`proposal` json,
	`validation` json,
	`status` varchar(16) NOT NULL,
	`mode` varchar(10) NOT NULL,
	`reason` varchar(64),
	`adopted_at` datetime(3),
	`erased_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `growth_candidates_id` PRIMARY KEY(`id`),
	CONSTRAINT `growth_candidate_scope_run` UNIQUE(`owner_id`,`source_run_id`)
);
--> statement-breakpoint
CREATE TABLE `growth_controls` (
	`id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`companion_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`runtime_epoch` int NOT NULL,
	`version` int NOT NULL,
	`frozen` boolean NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`fingerprint` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `growth_controls_id` PRIMARY KEY(`id`),
	CONSTRAINT `growth_control_version` UNIQUE(`owner_id`,`companion_id`,`runtime_epoch`,`version`),
	CONSTRAINT `growth_control_request` UNIQUE(`owner_id`,`companion_id`,`request_id`),
	CONSTRAINT `growth_control_positive` CHECK(`growth_controls`.`runtime_epoch` > 0 AND `growth_controls`.`version` > 0)
);
--> statement-breakpoint
ALTER TABLE `growth_candidates` ADD CONSTRAINT `growth_candidate_task_ref` FOREIGN KEY (`owner_id`,`id`) REFERENCES `tasks`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `growth_candidates` ADD CONSTRAINT `growth_candidate_run_ref` FOREIGN KEY (`owner_id`,`source_run_id`) REFERENCES `reflection_runs`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `growth_controls` ADD CONSTRAINT `growth_control_companion_ref` FOREIGN KEY (`owner_id`,`companion_id`) REFERENCES `companions`(`owner_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `growth_candidate_scope` ON `growth_candidates` (`owner_id`,`companion_id`,`runtime_epoch`,`created_at`);