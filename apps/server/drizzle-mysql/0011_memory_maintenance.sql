CREATE TABLE `memory_embedding_selections` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`version` int NOT NULL,
	`request_id` char(36) character set ascii collate ascii_general_ci,
	`fingerprint` varchar(64),
	`space` varchar(64) NOT NULL,
	`previous` varchar(64),
	`evaluation_note` varchar(500) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `embedding_selection_version` UNIQUE(`owner_id`,`version`),
	CONSTRAINT `embedding_selection_request` UNIQUE(`owner_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_embedding_spaces` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`space` varchar(64) NOT NULL,
	`config_version` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `embedding_space_owner_id` UNIQUE(`owner_id`,`space`)
);
--> statement-breakpoint
CREATE TABLE `memory_maintenance_heads` (
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`next_at` datetime(3) NOT NULL,
	CONSTRAINT `memory_maintenance_heads_owner_id` PRIMARY KEY(`owner_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_maintenance_views` (
	`version_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`owner_id` char(36) character set ascii collate ascii_general_ci NOT NULL,
	`tier` varchar(12) NOT NULL,
	`summary` text,
	`last_evidence_at` datetime(3) NOT NULL,
	`evaluated_at` datetime(3) NOT NULL,
	`policy` json NOT NULL,
	CONSTRAINT `memory_maintenance_views_version_id` PRIMARY KEY(`version_id`)
);
--> statement-breakpoint
ALTER TABLE `memory_embedding_selections` ADD CONSTRAINT `memory_embedding_selections_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_embedding_spaces` ADD CONSTRAINT `memory_embedding_spaces_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_maintenance_heads` ADD CONSTRAINT `memory_maintenance_heads_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_maintenance_views` ADD CONSTRAINT `memory_maintenance_views_version_id_memory_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `memory_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memory_maintenance_views` ADD CONSTRAINT `memory_maintenance_views_owner_id_owners_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `memory_maintenance_owner_tier` ON `memory_maintenance_views` (`owner_id`,`tier`,`version_id`);